const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

// 설정 파일 경로
const CONFIG_PATH = path.join(process.env.APPDATA || (process.platform === 'darwin' ? process.env.HOME + '/Library/Application Support' : process.env.HOME + '/.config'), 'kimcady');
const CONFIG_FILE = path.join(CONFIG_PATH, 'config.json');

// 기본 StoreID (처음 실행하거나 설정 파일이 없는 경우 사용)
const DEFAULT_STORE_ID = '6690d7ea750ff9a6689e9af3';

// 암호화 키 (실제 운영에서는 환경 변수나 더 안전한 방법으로 관리 필요)
const ENCRYPTION_KEY = '8e3c54a78941e4a04c81fce3a89e54f7dfa127fc'; // 이것은 예시일 뿐, 실제 운영에서는 더 안전한 키 관리 필요

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
  
  if (config.encryptedPhone && config.encryptedPassword) {
    try {
      return {
        phone: decrypt(config.encryptedPhone),
        password: decrypt(config.encryptedPassword),
        hasCredentials: true
      };
    } catch (error) {
      console.error(`[ERROR] Failed to decrypt credentials: ${error.message}`);
    }
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
  
  try {
    config.encryptedPhone = encrypt(phone);
    config.encryptedPassword = encrypt(password);
    return saveConfig(config);
  } catch (error) {
    console.error(`[ERROR] Failed to encrypt credentials: ${error.message}`);
    return false;
  }
};

// 사용자 계정 정보 삭제
const clearUserCredentials = () => {
  const config = getConfig();
  
  delete config.encryptedPhone;
  delete config.encryptedPassword;
  
  return saveConfig(config);
};

// 암호화 함수
const encrypt = (text) => {
  try {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch (error) {
    console.error(`[ERROR] Encryption failed: ${error.message}`);
    throw error;
  }
};

// 복호화 함수
const decrypt = (text) => {
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts[0], 'hex');
    const encryptedText = Buffer.from(textParts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    console.error(`[ERROR] Decryption failed: ${error.message}`);
    throw error;
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
  getUserCredentials,
  saveUserCredentials,
  clearUserCredentials,
  CHROME_PATH: getChromePath(),
  TIMEOUT_MS: 5 * 60 * 1000, // 5분 타임아웃
  API_BASE_URL: 'https://api.dev.24golf.co.kr',
};
