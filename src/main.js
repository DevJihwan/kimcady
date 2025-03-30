const { app } = require('electron');
const { setupElectron } = require('./services/electron');
const { launchBrowser } = require('./services/puppeteer');
const { getAccessToken } = require('./utils/api');
const { setupRequestHandler } = require('./handlers/request');
const { setupResponseHandler } = require('./handlers/response');
const { TIMEOUT_MS } = require('./config/env');

const main = async () => {
  try {
    console.log('[INFO] Starting KimCaddie application...');
    setupElectron();

    // 액세스 토큰 가져오기
    let accessToken;
    try {
      console.log('[INFO] Attempting to get access token...');
      accessToken = await getAccessToken();
      console.log('[INFO] Successfully obtained access token');
    } catch (error) {
      console.error('[ERROR] Failed to start due to token error:', error.message);
      app.quit();
      return;
    }

    // 브라우저 시작
    let browserData;
    try {
      console.log('[INFO] Launching browser...');
      browserData = await launchBrowser();
      console.log('[INFO] Browser launched successfully');
    } catch (error) {
      console.error('[ERROR] Failed to launch browser:', error.message);
      app.quit();
      return;
    }

    const { page } = browserData;

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

    // 정기적인 토큰 갱신 설정 (1시간마다)
    let tokenRefreshInterval = setInterval(async () => {
      try {
        console.log('[INFO] Refreshing access token...');
        accessToken = await getAccessToken();
        console.log('[INFO] Token refreshed successfully');
      } catch (error) {
        console.error('[ERROR] Failed to refresh token:', error.message);
      }
    }, 60 * 60 * 1000); // 1시간마다

    // 핸들러 설정
    setupRequestHandler(page, accessToken, maps);
    setupResponseHandler(page, accessToken, maps);

    // 타임아웃 관리 (5분마다 확인)
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      let expiredCount = 0;
      
      for (const [key, { timestamp }] of maps.bookingDataMap.entries()) {
        if (now - timestamp > TIMEOUT_MS) {
          console.log(`[INFO] Timeout: Removing booking data for ${key}`);
          maps.bookingDataMap.delete(key);
          expiredCount++;
        }
      }
      
      if (expiredCount > 0) {
        console.log(`[INFO] Cleaned up ${expiredCount} expired booking data entries`);
      }
      
      // 매일 자정에 processedBookings 초기화
      const currentHour = new Date().getHours();
      const currentMinute = new Date().getMinutes();
      if (currentHour === 0 && currentMinute < 5) { // 자정~12:05 사이
        console.log('[INFO] Daily cleanup: Clearing processed bookings sets');
        maps.processedBookings.clear();
      }
    }, 60000); // 1분마다 확인

    // 애플리케이션 종료 시 정리
    app.on('will-quit', () => {
      console.log('[INFO] Application closing, cleaning up...');
      clearInterval(tokenRefreshInterval);
      clearInterval(cleanupInterval);
    });

    console.log('[INFO] Setup complete. Browser opened. Proceed with login and reservation management.');
  } catch (error) {
    console.error('[CRITICAL] Main process failed with unexpected error:', error);
    app.quit();
  }
};

process.on('uncaughtException', (error) => {
  console.error('[CRITICAL] Uncaught exception:', error);
  // 프로세스는 계속 실행
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled rejection at:', promise, 'reason:', reason);
  // 프로세스는 계속 실행
});

main().catch(error => {
  console.error('[ERROR] Main process failed:', error);
  app.quit();
});