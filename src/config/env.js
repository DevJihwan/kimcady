const path = require('path');
const fs = require('fs');
require('dotenv').config();

// StoreID를 동적으로 관리하기 위한 설정 파일 경로
const CONFIG_PATH = path.join(process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + '/.config'), 'kimcady');
const CONFIG_FILE = path.join(CONFIG_PATH, 'config.json');

// 기본 StoreID (처음 실행하거나 설정 파일이 없는 경우 사용)
const DEFAULT_STORE_ID = '6690d7ea750ff9a6689e9af3';

// 설정 파일에서 StoreID 읽기 또는 기본값 사용
const getStoreId = () => {
  try {
    // 설정 디렉토리가 없으면 생성
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(CONFIG_PATH, { recursive: true });
    }
    
    // 설정 파일이 있으면 읽기
    if (fs.existsSync(CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return config.storeId || DEFAULT_STORE_ID;
    }
  } catch (error) {
    console.error(`[ERROR] Failed to read config file: ${error.message}`);
  }
  
  return DEFAULT_STORE_ID;
};

// 설정 파일에 StoreID 저장
const saveStoreId = (storeId) => {
  try {
    // 설정 디렉토리가 없으면 생성
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(CONFIG_PATH, { recursive: true });
    }
    
    // 기존 설정 불러오기 또는 새로 생성
    let config = {};
    if (fs.existsSync(CONFIG_FILE)) {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
    
    // StoreID 업데이트 및 저장
    config.storeId = storeId;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
    
    console.log(`[INFO] Store ID updated and saved: ${storeId}`);
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to save store ID: ${error.message}`);
    return false;
  }
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
  CHROME_PATH: getChromePath(),
  TIMEOUT_MS: 5 * 60 * 1000, // 5분 타임아웃
  API_BASE_URL: 'https://api.dev.24golf.co.kr',
};
