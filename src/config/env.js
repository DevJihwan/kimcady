const path = require('path');
const fs = require('fs');
require('dotenv').config();

const STORE_ID = '6690d7ea750ff9a6689e9af3';

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
  STORE_ID,
  CHROME_PATH: getChromePath(),
  TIMEOUT_MS: 5 * 60 * 1000, // 5분 타임아웃
};