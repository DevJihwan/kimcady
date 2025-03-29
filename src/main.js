const { app } = require('electron');
const { setupElectron } = require('./services/electron');
const { launchBrowser } = require('./services/puppeteer');
const { getAccessToken } = require('./utils/api');
const { setupRequestHandler } = require('./handlers/request');
const { setupResponseHandler } = require('./handlers/response');
const { TIMEOUT_MS } = require('./config/env');

const main = async () => {
  setupElectron();

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (error) {
    console.error('Failed to start due to token error. Exiting...');
    app.quit();
    return;
  }

  const { page } = await launchBrowser();

  // 맵 객체 초기화
  const maps = {
    requestMap: new Map(),
    processedBookings: new Set(),
    paymentAmounts: new Map(),
    paymentStatus: new Map(),
    bookIdToIdxMap: new Map(),
    revenueToBookingMap: new Map(),
    bookingDataMap: new Map(), // 타임아웃 관리용 추가
  };

  // 핸들러 설정
  setupRequestHandler(page, accessToken, maps);
  setupResponseHandler(page, accessToken, maps);

  // 타임아웃 관리
  setInterval(() => {
    const now = Date.now();
    for (const [key, { timestamp }] of maps.bookingDataMap.entries()) {
      if (now - timestamp > TIMEOUT_MS) {
        console.log(`[INFO] Timeout: Removing booking data for ${key}`);
        maps.bookingDataMap.delete(key);
      }
    }
  }, 60000);

  console.log('Browser opened. Proceed with login and reservation management.');
};

main().catch(error => console.error('[ERROR] Main process failed:', error));