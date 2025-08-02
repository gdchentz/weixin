from machine import UART, Timer, idle
import time
import ubluetooth as bluetooth
import struct
import machine 
from machine import Pin
import math

sLed = Pin(2, Pin.OUT)
sLed.on()

# ===== 蓝牙距离测算配置 =====
CALIBRATION_SAMPLES = 10   # 校准采样次数
DISTANCE_UPDATE_MS = 2000  # 距离更新间隔(ms)
ENVIRONMENT_FACTOR = 2.5    # 默认环境衰减因子
REF_RSSI = -59             # 1米处默认RSSI值
rssi_values = []           # RSSI历史数据缓存
last_distance_time = 0     # 上次计算距离的时间
current_distance = 0.0     # 当前计算距离

# ===== 定义蓝牙事件常量 =====
_IRQ_CENTRAL_CONNECT = const(1)
_IRQ_CENTRAL_DISCONNECT = const(2)
_IRQ_GATTS_WRITE = const(3)
_IRQ_GAP_RSSI = const(15)  # RSSI事件常量 [5](@ref)
_FLAG_READ = const(0x0002)
_FLAG_NOTIFY = const(0x0010)
_FLAG_WRITE = const(0x0008)
_FLAG_WRITE_NO_RESPONSE = const(0x0004)

# ===== 蓝牙配置 =====
BT_NAME = "ESP32_Modbus"
CONNECT_MSG = b'\x68\x40\xBF\x68\x04\x06\x73\x50\x30\x33\x33\x33'
ble = bluetooth.BLE()
bt_active = False
conn_handle = None
tx_handle = None
rx_handle = None

# ===== Nordic UART服务定义 =====
_UART_UUID = bluetooth.UUID("6E400001-B5A3-F393-E0A9-E50E24DCCA9E")
_UART_TX_UUID = bluetooth.UUID("6E400002-B5A3-F393-E0A9-E50E24DCCA9E")
_UART_RX_UUID = bluetooth.UUID("6E400003-B5A3-F393-E0A9-E50E24DCCA9E")
_UART_TX = (_UART_TX_UUID, _FLAG_READ | _FLAG_NOTIFY)
_UART_RX = (_UART_RX_UUID, _FLAG_WRITE | _FLAG_WRITE_NO_RESPONSE)
_UART_SERVICE = (_UART_UUID, (_UART_TX, _UART_RX))

# ===== 蓝牙距离测算函数 =====[1,3,6](@ref)
def calculate_distance(rssi, ref_rssi=REF_RSSI, n=ENVIRONMENT_FACTOR):
    """
    根据RSSI计算距离
    公式: distance = 10^((ref_rssi - rssi) / (10 * n))
    """
    if rssi >= 0:  # RSSI应为负值，处理异常情况
        return -1.0
    
    try:
        # 使用Log-Normal Shadowing模型[2,6](@ref)
        exponent = (ref_rssi - rssi) / (10 * n)
        return round(math.pow(10, exponent), 2)
    except:
        return -1.0

def calibrate_reference_rssi():
    """校准参考RSSI值(在1米距离)"""
    print("开始校准...请将设备放置在1米距离处")
    global REF_RSSI
    rssi_sum = 0
    valid_samples = 0
    
    for i in range(CALIBRATION_SAMPLES * 2):
        time.sleep_ms(500)
        if ble.gap_rssi(conn_handle) is not None:
            rssi = ble.gap_rssi(conn_handle)[1]
            if rssi < 0:  # 有效RSSI
                rssi_sum += rssi
                valid_samples += 1
                print(f"采样 {valid_samples}/{CALIBRATION_SAMPLES}: RSSI={rssi}")
            if valid_samples >= CALIBRATION_SAMPLES:
                break
    
    if valid_samples > 0:
        REF_RSSI = rssi_sum / valid_samples
        print(f"校准完成! 新参考RSSI: {REF_RSSI:.2f} dBm")
        return True
    return False

def update_distance(rssi):
    """更新距离值并应用指数平滑滤波"""
    global current_distance, rssi_values
    
    # 添加新采样值
    rssi_values.append(rssi)
    if len(rssi_values) > 5:  # 保留最近5个样本
        rssi_values.pop(0)
    
    # 使用中值滤波减少波动
    sorted_rssi = sorted(rssi_values)
    median_rssi = sorted_rssi[len(sorted_rssi) // 2]
    
    # 计算新距离
    new_distance = calculate_distance(median_rssi, REF_RSSI, ENVIRONMENT_FACTOR)
    
    # 应用指数平滑
    if current_distance <= 0:
        current_distance = new_distance
    else:
        alpha = 0.2  # 平滑因子
        current_distance = round(alpha * new_distance + (1 - alpha) * current_distance, 2)
    
    return current_distance

# ===== 蓝牙初始化函数 =====
def init_bluetooth():
    global ble, tx_handle, rx_handle
    ble.active(True)
    # 注册服务
    services = ble.gatts_register_services([_UART_SERVICE])
    tx_handle = services[0][0]
    rx_handle = services[0][1]
    
    # 创建广播数据包
    adv_payload = bytearray()
    adv_payload += struct.pack("BBB", 0x02, 0x01, 0x06)
    name_bytes = BT_NAME.encode()
    adv_payload += struct.pack("B", len(name_bytes) + 1)
    adv_payload += b'\x09'
    adv_payload += name_bytes
    
    # 扫描响应数据包
    scan_resp = bytearray()
    uuid_bytes = bytes(_UART_UUID)
    scan_resp += struct.pack("B", len(uuid_bytes) + 1)
    scan_resp += b'\x06'
    scan_resp += uuid_bytes
    
    ble.gap_advertise(30_000, adv_data=adv_payload, resp_data=scan_resp)
    print("BLE广播已启动:", BT_NAME)

# ===== 蓝牙事件回调 =====
def bt_callback(event, data):
    global bt_active, conn_handle, last_distance_time
    
    if event == _IRQ_CENTRAL_CONNECT:
        sLed.off()
        conn_handle, _, _ = data
        print("设备已连接! 句柄:", conn_handle)
        bt_active = True
        
        # 启用RSSI报告[5](@ref)
        ble.gap_rssi(conn_handle, 100)  # 每100ms报告一次RSSI
        uart.write(CONNECT_MSG)
        
    elif event == _IRQ_CENTRAL_DISCONNECT:
        conn_handle, _, _ = data
        sLed.on()
        print("设备断开! 句柄:", conn_handle)
        bt_active = False
        conn_handle = None
        ble.gap_advertise(30_000)
        
    elif event == _IRQ_GATTS_WRITE:
        conn_handle, value_handle = data
        if value_handle == rx_handle and bt_active:
            received_data = ble.gatts_read(rx_handle)
            print(f"received_data:{received_data}")
            ble.gatts_notify(conn_handle, tx_handle, received_data)
    
    # 处理RSSI事件[5](@ref)
    elif event == _IRQ_GAP_RSSI and bt_active:
        _, rssi, _ = data
        current_time = time.ticks_ms()
        
        # 定期更新距离
        if time.ticks_diff(current_time, last_distance_time) > DISTANCE_UPDATE_MS:
            distance = update_distance(rssi)
            if distance > 0:
                print(f"距离: {distance}米 | RSSI: {rssi} dBm")
                last_distance_time = current_time

# ===== 注册回调 =====
ble.irq(bt_callback)

# ===== 串口配置 =====
SLAVE_ID = 1
uart = UART(2, baudrate=9600, bits=8, parity=None, stop=1, tx=17, rx=16)
MAX_FRAME_LEN = 64
rx_buffer = bytearray(MAX_FRAME_LEN)
rx_index = 0
last_rx_time = 0

# ===== CRC查表优化 =====
CRC16_TABLE = [
    0x0000, 0xC0C1, 0xC181, 0x0140, 0xC301, 0x03C0, 0x0280, 0xC241, 0xC601, 0x06C0, 0x0780, 0xC741, 0x0500, 0xC5C1, 0xC481, 0x0440,
    0xCC01, 0x0CC0, 0x0D80, 0xCD41, 0x0F00, 0xCFC1, 0xCE81, 0x0E40, 0x0A00, 0xCAC1, 0xCB81, 0x0B40, 0xC901, 0x09C0, 0x0880, 0xC841,
    0xD801, 0x18C0, 0x1980, 0xD941, 0x1B00, 0xDBC1, 0xDA81, 0x1A40, 0x1E00, 0xDEC1, 0xDF81, 0x1F40, 0xDD01, 0x1DC0, 0x1C80, 0xDC41,
    0x1400, 0xD4C1, 0xD581, 0x1540, 0xD701, 0x17C0, 0x1680, 0xD641, 0xD201, 0x12C0, 0x1380, 0xD341, 0x1100, 0xD1C1, 0xD081, 0x1040,
    0xF001, 0x30C0, 0x3180, 0xF141, 0x3300, 0xF3C1, 0xF281, 0x3240, 0x3600, 0xF6C1, 0xF781, 0x3740, 0xF501, 0x35C0, 0x3480, 0xF441,
    0x3C00, 0xFCC1, 0xFD81, 0x3D40, 0xFF01, 0x3FC0, 0x3E80, 0xFE41, 0xFA01, 0x3AC0, 0x3B80, 0xFB41, 0x3900, 0xF9C1, 0xF881, 0x3840,
    0x2800, 0xE8C1, 0xE981, 0x2940, 0xEB01, 0x2BC0, 0x2A80, 0xEA41, 0xEE01, 0x2EC0, 0x2F80, 0xEF41, 0x2D00, 0xEDC1, 0xEC81, 0x2C40,
    0xE401, 0x24C0, 0x2580, 0xE541, 0x2700, 0xE7C1, 0xE681, 0x2640, 0x2200, 0xE2C1, 0xE381, 0x2340, 0xE101, 0x21C0, 0x2080, 0xE041,
    0xA001, 0x60C0, 0x6180, 0xA141, 0x6300, 0xA3C1, 0xA281, 0x6240, 0x6600, 0xA6C1, 0xA781, 0x6740, 0xA501, 0x65C0, 0x6480, 0xA441,
    0x6C00, 0xACC1, 0xAD81, 0x6D40, 0xAF01, 0x6FC0, 0x6E80, 0xAE41, 0xAA01, 0x6AC0, 0x6B80, 0xAB41, 0x6900, 0xA9C1, 0xA881, 0x6840,
    0x7800, 0xB8C1, 0xB981, 0x7940, 0xBB01, 0x7BC0, 0x7A80, 0xBA41, 0xBE01, 0x7EC0, 0x7F80, 0xBF41, 0x7D00, 0xBDC1, 0xBC81, 0x7C40,
    0xB401, 0x74C0, 0x7580, 0xB541, 0x7700, 0xB7C1, 0xB681, 0x7640, 0x7200, 0xB2C1, 0xB381, 0x7340, 0xB101, 0x71C0, 0x7080, 0xB041,
    0x5000, 0x90C1, 0x9181, 0x5140, 0x9301, 0x53C0, 0x5280, 0x9241, 0x9601, 0x56C0, 0x5780, 0x9741, 0x5500, 0x95C1, 0x9481, 0x5440,
    0x9C01, 0x5CC0, 0x5D80, 0x9D41, 0x5F00, 0x9FC1, 0x9E81, 0x5E40, 0x5A00, 0x9AC1, 0x9B81, 0x5B40, 0x9901, 0x59C0, 0x5880, 0x9841,
    0x8801, 0x48C0, 0x4980, 0x8941, 0x4B00, 0x8BC1, 0x8A81, 0x4A40, 0x4E00, 0x8EC1, 0x8F81, 0x4F40, 0x8D01, 0x4DC0, 0x4C80, 0x8C41,
    0x4400, 0x84C1, 0x8581, 0x4540, 0x8701, 0x47C0, 0x4680, 0x8641, 0x8201, 0x42C0, 0x4380, 0x8341, 0x4100, 0x81C1, 0x8081, 0x4040
]

def fast_crc(data):
    crc = 0xFFFF
    for byte in data:
        crc = (crc >> 8) ^ CRC16_TABLE[(crc ^ byte) & 0xFF]
    return crc.to_bytes(2, 'little')

# ===== 寄存器初始化 =====
REG_BUF = bytearray(20)
REG_BUF[0:2] = (1234).to_bytes(2, 'big')
REG_BUF[2:4] = (3335).to_bytes(2, 'big')

# ===== Modbus处理函数 =====
def process_request(req):
    if len(req) < 8 or req[0] != SLAVE_ID:
        return None
    if req[-2:] != fast_crc(req[:-2]):
        return None
        
    func_code = req[1]
    if func_code == 0x03:  # 读保持寄存器
        start_addr = int.from_bytes(req[2:4], 'big') * 2
        reg_count = int.from_bytes(req[4:6], 'big') * 2
        end_addr = start_addr + reg_count
        
        if end_addr > len(REG_BUF) or start_addr < 0:
            return build_exception_response(func_code, 0x02)  # 非法数据地址
        
        # 构建响应
        header = bytes([SLAVE_ID, func_code, reg_count])
        data = REG_BUF[start_addr:end_addr]
        crc = fast_crc(header + data)
        return header + data + crc
    
    # 可扩展其他功能码...
    return None

def build_exception_response(func_code, exception_code):
    resp = bytes([SLAVE_ID, func_code | 0x80, exception_code])
    return resp + fast_crc(resp)

# ===== 串口轮询函数 =====
def poll_uart(timer=None):
    global rx_index, last_rx_time
    machine.idle()  # 释放CPU资源
    
    now = time.ticks_ms()
    # 帧超时检测（3.5字符时间≈4ms/字节）
    if rx_index > 0 and time.ticks_diff(now, last_rx_time) > 32:  # 8字节×4ms=32ms
        frame = bytes(rx_buffer[:rx_index])
        rx_index = 0
        if response := process_request(frame):
            uart.write(response)
    
    # 批量读取串口数据
    if uart.any():
        avail = min(MAX_FRAME_LEN - rx_index, uart.any())
        if avail > 0:
            data = uart.read(avail)
            rx_buffer[rx_index:rx_index+len(data)] = data
            rx_index += len(data)
            last_rx_time = now

# ===== 主程序初始化 =====
init_bluetooth()
tim = Timer(0)
tim.init(period=50, mode=Timer.PERIODIC, callback=poll_uart)

print("系统已启动，等待BLE连接...")
print("连接后使用 calibrate_reference_rssi() 进行校准")

while True:
    time.sleep_ms(10)
    machine.idle()  # 主循环中释放CPU