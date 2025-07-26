const app = getApp();
const MAX_RETRY = 5;
const DEVICE_UPDATE_INTERVAL = 5000;
const CONNECT_TIMEOUT = 8000;

Page({
  data: {
    devices: [],
    connected: false,
    connecting: false,
    receivedData: "",
    currentDevice: null,
    log: [],
    serviceId: "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
    writeCharId: "6E400003-B5A3-F393-E0A9-E50E24DCCA9E",
    notifyCharId: "6E400002-B5A3-F393-E0A9-E50E24DCCA9E",
    retryCount: 0,
    logScrollTop: 0,
    showDeviceList: false,
    scrollHeight: 200,
    isDiscovering: false,
    knownDevices: {},
    connectionTimer: null,
    deviceId: null, // 初始化为null确保有效状态
  },
  
  onReady() {
    this.calculateScrollHeight();
  },
  
  onShareAppMessage() {
    return { title: '测试标题', path: '/pages/index/index' };
  },
  
  onShareTimeline() {
    return { title: '朋友圈标题' };
  },
  
  calculateScrollHeight() {
    const systemInfo = wx.getSystemInfoSync();
    const windowHeight = systemInfo.windowHeight;
    const query = wx.createSelectorQuery();
    
    query.select('.content-area').boundingClientRect();
    query.select('.device-list').boundingClientRect();
    query.exec(res => {
      if (res[0] && res[1]) {
        const otherHeight = res[0].height - res[1].height;
        const safeArea = systemInfo.safeArea ? windowHeight - systemInfo.safeArea.bottom : 0;
        const height = Math.max(150, windowHeight - otherHeight - safeArea);
        
        this.setData({ scrollHeight: height });
      }
    });
  },
  
  clearLog() {
    this.setData({ log: [] });
  },
  
  log(msg) {
    const timestamp = new Date().toLocaleTimeString();
    const newItem = `[${timestamp}] ${msg}`;
    const newLog = [newItem, ...this.data.log].slice(0, 50);
    
    this.setData({
      log: newLog,
      logScrollTop: 0
    }, () => {
      setTimeout(() => this.setData({ logScrollTop: 0 }), 100);
    });
  },
  
  initBluetooth() {
    this.setData({ 
      devices: [],
      knownDevices: {}
    });
    
    if (wx.clearBleCache) {
      wx.clearBleCache({
        complete: () => {
          this.log("♻️ 蓝牙缓存已清除");
        }
      });
    }
    
    this.log("初始化蓝牙适配器...");
    wx.openBluetoothAdapter({
      success: () => {
        this.log("✅ 蓝牙初始化成功");
        this.startDiscovery();
      },
      fail: (err) => this.handleError("❌ 初始化失败", err)
    });
  },

  startDiscovery() {
    this.stopDiscovery().then(() => {
      this.setData({ 
        showDeviceList: true,
        isDiscovering: true
      });
      
      wx.startBluetoothDevicesDiscovery({
        allowDuplicatesKey: true,
        interval: 2000,
        success: () => {
          this.log("🔍 设备扫描中...");
          this.listenDeviceFound();
        },
        fail: (err) => this.handleError("❌ 搜索失败", err)
      });
    });
  },

  listenDeviceFound() {
    wx.offBluetoothDeviceFound();
    
    wx.onBluetoothDeviceFound((res) => {
      if (!this.data.isDiscovering) return;
      
      const now = Date.now();
      const newDevices = [];
      const updatedDevices = [...this.data.devices];
      const knownDevices = {...this.data.knownDevices};
      let hasUpdates = false;

      res.devices.forEach(device => {
        const deviceId = device.deviceId;
        const localName = device.advertisData?.localName || device.name;
        
        if (!localName || localName.includes("Bluetooth LE Device") || localName.startsWith("GL_")) {
          return;
        }
        
        if (!knownDevices[deviceId]) {
          const newDevice = {
            ...device,
            localName,
            lastSeen: now
          };
          updatedDevices.push(newDevice);
          knownDevices[deviceId] = newDevice;
          hasUpdates = true;
          
          this.log(`发现新设备: ${localName}`);
        } else {
          const lastUpdateTime = knownDevices[deviceId].lastSeen || 0;
          
          if (now - lastUpdateTime > DEVICE_UPDATE_INTERVAL) {
            const existingIndex = updatedDevices.findIndex(d => d.deviceId === deviceId);
            if (existingIndex !== -1) {
              updatedDevices[existingIndex].RSSI = device.RSSI;
              updatedDevices[existingIndex].lastSeen = now;
              knownDevices[deviceId] = updatedDevices[existingIndex];
              hasUpdates = true;
              
              this.log(`更新设备信号: ${localName} | ${device.RSSI}dBm`);
            }
          }
        }
      });
      
      if (hasUpdates) {
        this.setData({
          devices: updatedDevices,
          knownDevices: knownDevices
        });
      }
    });
  },

  stopDiscovery() {
    return new Promise(resolve => {
      if (this.data.isDiscovering) {
        wx.stopBluetoothDevicesDiscovery({
          complete: () => {
            this.log("已停止当前搜索");
            this.setData({ isDiscovering: false });
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  },
  
  async connectDevice(e) {
    const deviceId = e.currentTarget.dataset.id;
    const device = this.data.devices.find(d => d.deviceId === deviceId);
    
    if (this.data.connecting) {
      this.log("⚠️ 连接正在进行中，忽略本次请求");
      return;
    }
    
    this.setData({ 
      connecting: true, 
      retryCount: 0,
      // 关键修复：立即存储设备ID
      deviceId: deviceId
    });
    
    this.log(`🔗 连接设备: ${device.localName || device.name || deviceId.substr(0,6)}...`);
    this.log(`[DEBUG] 连接开始: 当前deviceId = ${this.data.deviceId}`);
    
    this.setConnectionTimeout(deviceId);
    
    try {
      await this.forceDisconnect(deviceId);
      await this.tryConnect(deviceId, device);
    } catch (err) {
      this.handleConnectionError(deviceId, err);
    }
  },
  
  setConnectionTimeout(deviceId) {
    if (this.data.connectionTimer) {
      clearTimeout(this.data.connectionTimer);
    }
    
    this.data.connectionTimer = setTimeout(() => {
      if (this.data.connecting) {
        this.log(`⌛ 连接超时: ${deviceId.substr(0,6)}`);
        this.handleError("❌ 连接超时", {errMsg: "设备响应超时"});
        this.setData({ connecting: false });
      }
    }, CONNECT_TIMEOUT);
  },
  
  async forceDisconnect(deviceId) {
    return new Promise((resolve) => {
      wx.closeBLEConnection({
        deviceId,
        complete: () => {
          this.log("♻️ 强制断开旧连接完成");
          resolve();
        }
      });
    });
  },
  
  async tryConnect(deviceId, device) {
    return new Promise((resolve, reject) => {
      wx.createBLEConnection({
        deviceId,
        timeout: 10000,
        success: () => {
          this.log("✅ 连接建立成功");
          this.clearConnectionTimer();
          this.onConnectSuccess(deviceId, device);
          resolve();
        },
        fail: (err) => {
          if (err.errCode === 10003 || err.errMsg.includes('already')) {
            this.log(`⚠️ 连接已存在，尝试恢复...`);
            this.onConnectSuccess(deviceId, device);
            resolve();
          } 
          else if (this.data.retryCount < MAX_RETRY) {
            this.setData({ retryCount: this.data.retryCount + 1 });
            this.log(`🔄 第${this.data.retryCount}次重试...`);
            setTimeout(() => this.tryConnect(deviceId, device), 500);
          } else {
            this.clearConnectionTimer();
            reject(new Error(`连接失败: ${err.errMsg}`));
          }
        }
      });
    });
  },
  
  clearConnectionTimer() {
    if (this.data.connectionTimer) {
      clearTimeout(this.data.connectionTimer);
      this.data.connectionTimer = null;
    }
  },
  
  handleConnectionError(deviceId, err) {
    this.clearConnectionTimer();
    this.handleError("❌ 连接失败", err);
    this.setData({ connecting: false, deviceId: null });
    this.forceDisconnect(deviceId);
  },
  
  onConnectSuccess(deviceId, device) {
    // 关键修复：正确更新deviceId状态
    this.setData({ 
      connected: true,
      deviceId: deviceId, // 使用成功连接的deviceId
      currentDevice: device,
      isDiscovering: false,
      connecting: false
    }, () => {
      // 确认状态更新成功
      this.log(`✅ 状态更新完成 deviceId: ${this.data.deviceId}`);
      
      // 设置连接状态监听
      wx.onBLEConnectionStateChange((res) => {
        if (!res.connected) {
          this.log("⚠️ 连接断开，释放资源");
          this.setData({ 
            connected: false,
            deviceId: null // 清除设备ID
          });
          this.startDiscovery();
        }
      });
      
      // 开始服务发现
      this.discoverServices(deviceId);
    });
  },
  
  async discoverServices(deviceId) {
    try {
      this.log("🔍 发现服务...");
      const services = await new Promise((resolve, reject) => {
        wx.getBLEDeviceServices({
          deviceId,
          success: (res) => resolve(res.services),
          fail: reject
        });
      });
      
      let targetService = null;
      if (app.globalData.serviceId) {
        targetService = services.find(svc => 
          svc.uuid.toLowerCase() === app.globalData.serviceId.toLowerCase()
        );
      }
      
      if (!targetService) {
        targetService = services.find(svc => 
          svc.uuid.toLowerCase().includes('modbus')
        );
      }
      
      if (!targetService && services.length > 0) {
        targetService = services[0];
        this.log(`⚠️ 使用回退服务: ${targetService.uuid}`);
      }
      
      if (!targetService) throw new Error("未找到目标服务");
      
      this.getCharacteristics(deviceId, targetService.uuid);
    } catch (err) {
      this.handleError("❌ 服务发现失败", err);
      this.setData({ connecting: false, connected: false, deviceId: null });
      this.forceDisconnect(deviceId);
    }
  },
  
  async getCharacteristics(deviceId, serviceId) {
    try {
      this.log("🔍 获取特征值...");
      const characteristics = await new Promise((resolve, reject) => {
        wx.getBLEDeviceCharacteristics({
          deviceId,
          serviceId,
          success: (res) => resolve(res.characteristics),
          fail: reject
        });
      });
      
      let writeChar = null;
      let notifyChar = null;
      
      if (app.globalData.writeCharId) {
        writeChar = characteristics.find(c => 
          c.properties.write && 
          c.uuid.toLowerCase() === app.globalData.writeCharId.toLowerCase()
        );
      }
      
      if (app.globalData.notifyCharId) {
        notifyChar = characteristics.find(c => 
          (c.properties.notify || c.properties.indicate) && 
          c.uuid.toLowerCase() === app.globalData.notifyCharId.toLowerCase()
        );
      }
      
      if (!writeChar) {
        writeChar = characteristics.find(c => 
          c.properties.write && 
          (c.uuid.toLowerCase().includes('write') || c.uuid.toLowerCase().endsWith('01'))
        );
      }
      
      if (!notifyChar) {
        notifyChar = characteristics.find(c => 
          (c.properties.notify || c.properties.indicate) && 
          (c.uuid.toLowerCase().includes('notify') || c.uuid.toLowerCase().endsWith('02'))
        );
      }
      
      if (!writeChar || !notifyChar) {
        this.log("⚠️ 特征值匹配失败，使用默认特征值");
        writeChar = characteristics.find(c => c.properties.write);
        notifyChar = characteristics.find(c => c.properties.notify || c.properties.indicate);
      }
      
      if (!writeChar || !notifyChar) throw new Error("特征值不匹配");
      
      this.setData({
        serviceId: serviceId,
        writeCharId: writeChar.uuid,
        notifyCharId: notifyChar.uuid
      });
      
      this.enableNotifications();
    } catch (err) {
      this.handleError("❌ 特征值获取失败", err);
      this.setData({ connecting: false, connected: false, deviceId: null });
      this.forceDisconnect(deviceId);
    }
  },
  
  enableNotifications() {
    // 安全检测：确保deviceId有效
    if (!this.data.deviceId) {
      this.log("❌ 无法启用通知：缺少有效的设备ID");
      return;
    }
    
    const { deviceId, serviceId, notifyCharId } = this.data;
    this.log("🔔 启用通知...");
    this.log(`[INFO] 设备ID: ${deviceId}`);
    
    wx.notifyBLECharacteristicValueChange({
      deviceId,
      serviceId,
      characteristicId: notifyCharId,
      state: true,
      success: () => {
        this.log("✅ 通知启用成功");
        this.listenForData();
      },
      fail: (err) => this.handleError("❌ 通知启用失败", err)
    });
  },
  
  listenForData() {
    wx.onBLECharacteristicValueChange((res) => {
      const value = this.ab2hex(res.value);
      this.setData({ 
        receivedData: value,
        log: [`📥 收到数据: ${value}`, ...this.data.log].slice(0, 50)
      });
    });
  },
  
  sendData() {
    const { deviceId, serviceId, writeCharId } = this.data;
    
    // 验证必要参数
    if (!serviceId || !writeCharId || !deviceId) {
      this.handleError("❌ 发送失败", { errMsg: "蓝牙参数无效" });
      return;
    }
    
    const data = "AABBCCDD"; // 示例数据
    wx.writeBLECharacteristicValue({
      deviceId,
      serviceId,
      characteristicId: writeCharId,
      value: this.hex2ab(data),
      success: () => this.log(`📤 发送成功: ${data}`),
      fail: (err) => this.handleError("❌ 发送失败", err)
    });
  },
  
  disconnect() {
    if (!this.data.currentDevice || !this.data.deviceId) {
      this.log("⚠️ 无有效连接可断开");
      return;
    }
    
    this.forceDisconnect(this.data.deviceId).then(() => {
      wx.stopBluetoothDevicesDiscovery({
        success: () => {
          this.log("已停止蓝牙扫描");
        }
      });
      
      this.setData({
        connected: false,
        currentDevice: null,
        deviceId: null, // 清除设备ID
        showDeviceList: true
      });
      
      this.log("🔌 已断开连接");
    });
  },
  
  ab2hex(buffer) {
    if (!buffer || buffer.byteLength === 0) return "";
    return Array.from(new Uint8Array(buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },
  
  hex2ab(hex) {
    const matches = hex.match(/[\da-f]{2}/gi);
    if (!matches) return new ArrayBuffer(0);
    
    const bytes = new Uint8Array(matches.map(h => parseInt(h, 16)));
    return bytes.buffer;
  },
  
  handleError(prefix, err) {
    const msg = `${prefix}: ${err.errMsg || err.message}`;
    this.log(msg);
    wx.showToast({ title: msg, icon: "none", duration: 3000 });
  },
  
  onUnload() {
    if (this.data.connected) {
      const deviceId = this.data.currentDevice?.deviceId || this.data.deviceId;
      this.forceDisconnect(deviceId);
      wx.stopBluetoothDevicesDiscovery();
      wx.closeBluetoothAdapter();
      this.log("♻️ 蓝牙资源已释放");
    }
    wx.offBluetoothDeviceFound();
    wx.offBLEConnectionStateChange();
  }
})