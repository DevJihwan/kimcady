const path = require('path');
const fs = require('fs');
require('dotenv').config();

// 설정 파일 경로
const CONFIG_PATH = path.join(process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + '/.config'), 'kimcady');
const CONFIG_FILE = path.join(CONFIG_PATH, 'config.json');

// 기본 StoreID (처음 실행하거나 설정 파일이 없는 경우 사용)
const DEFAULT_STORE_ID = '6690d7ea750ff9a6689e9af3';

// 설정 파일에서 읽기
const getConfig = () => {
  try {
    // 설정 디렉토리가 없으면 생성
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(CONFIG_PATH, { recursive: true });
    }
    
    // 설정 파일이 있으면 읽기
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (error) {
    console.error(`[ERROR] Failed to read config file: ${error.message}`);
  }
  
  return { storeId: DEFAULT_STORE_ID };
};

// 설정 파일에 저장
const saveConfig = (config) => {
  try {
    // 설정 디렉토리가 없으면 생성
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(CONFIG_PATH, { recursive: true });
    }
    
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    console.log(`[INFO] Config saved successfully`);
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to save config: ${error.message}`);
    return false;
  }
};

// 매장 ID 가져오기
const getStoreId = () => {
  const config = getConfig();
  return config.storeId || DEFAULT_STORE_ID;
};

// 매장 ID 저장
const saveStoreId = (storeId) => {
  const config = getConfig();
  config.storeId = storeId;
  return saveConfig(config);
};

// 사용자 계정 정보 가져오기
const getUserCredentials = () => {
  const config = getConfig();
  
  if (config.userPhone && config.userPassword) {
    return {
      phone: config.userPhone,
      password: config.userPassword,
      hasCredentials: true
    };
  }
  
  return { 
    phone: '', 
    password: '',
    hasCredentials: false
  };
};

// 사용자 계정 정보 저장
const saveUserCredentials = (phone, password) => {
  const config = getConfig();
  
  config.userPhone = phone;
  config.userPassword = password;
  
  return saveConfig(config);
};

// 사용자 계정 정보 삭제
const clearUserCredentials = () => {
  const config = getConfig();
  
  delete config.userPhone;
  delete config.userPassword;
  
  return saveConfig(config);
};

const getChromePath = () => {
  if (process.platform === 'win32') {
    const defaultPath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    return fs.existsSync(defaultPath) ? defaultPath : 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  } else if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  } else {
    return '/usr/bin/google-chrome';
  }
};

module.exports = {
  getStoreId,
  saveStoreId,
  getUserCredentials,
  saveUserCredentials,
  clearUserCredentials,
  CHROME_PATH: getChromePath(),
  TIMEOUT_MS: 5 * 60 * 1000, // 5분 타임아웃
  API_BASE_URL: 'https://api.dev.24golf.co.kr',
};
