const { app, ipcMain } = require('electron');
const { setupElectron } = require('./services/electron');
const { launchBrowser } = require('./services/puppeteer');
const { getAccessToken, getStoreInfo } = require('./utils/api');
const { setupRequestHandler } = require('./handlers/request');
const { setupResponseHandler } = require('./handlers/response');
const { 
  getStoreId, 
  saveStoreId, 
  getUserCredentials, 
  saveUserCredentials, 
  clearUserCredentials,
  TIMEOUT_MS 
} = require('./config/env');

// 글로벌 변수
let accessToken = null;
let mainWindow = null;
let appStatus = 'initializing';

const main = async () => {
  try {
    console.log('[INFO] Starting KimCaddie application...');
    mainWindow = setupElectron();
    updateAppStatus('초기화 중...');

    // 액세스 토큰 가져오기
    try {
      console.log('[INFO] Attempting to get access token...');
      accessToken = await getAccessToken();
      console.log('[INFO] Successfully obtained access token');
    } catch (error) {
      console.error('[ERROR] Failed to start due to token error:', error.message);
      updateAppStatus('토큰 오류: ' + error.message);
      return;
    }

    // 브라우저 시작
    let browserData;
    try {
      updateAppStatus('브라우저 시작 중...');
      console.log('[INFO] Launching browser...');
      browserData = await launchBrowser();
      console.log('[INFO] Browser launched successfully');
    } catch (error) {
      console.error('[ERROR] Failed to launch browser:', error.message);
      updateAppStatus('브라우저 오류: ' + error.message);
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
        updateAppStatus('토큰 갱신 오류');
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

    // 매장 정보 로딩
    try {
      const storeId = getStoreId();
      const storeInfo = await getStoreInfo(storeId);
      if (storeInfo.success) {
        console.log(`[INFO] Store information loaded: ${storeInfo.name}${storeInfo.branch ? ` (${storeInfo.branch})` : ''}`);
        updateAppStatus('수집 중...');
      } else {
        console.warn(`[WARN] Failed to load store information: ${storeInfo.error}`);
        updateAppStatus('매장 정보 오류');
      }
    } catch (error) {
      console.error(`[ERROR] Error loading store information: ${error.message}`);
      updateAppStatus('매장 정보 오류');
    }

    // 애플리케이션 종료 시 정리
    app.on('will-quit', () => {
      console.log('[INFO] Application closing, cleaning up...');
      clearInterval(tokenRefreshInterval);
      clearInterval(cleanupInterval);
    });

    console.log('[INFO] Setup complete. Browser opened. Proceed with login and reservation management.');
  } catch (error) {
    console.error('[CRITICAL] Main process failed with unexpected error:', error);
    updateAppStatus('치명적 오류');
    app.quit();
  }
};

// 앱 상태 업데이트 함수
function updateAppStatus(status) {
  appStatus = status;
  if (mainWindow) {
    mainWindow.webContents.send('app-status', status);
  }
}

// IPC 이벤트 핸들러 설정
function setupIpcHandlers() {
  // 현재 매장 정보 요청 처리
  ipcMain.on('get-store-info', async (event) => {
    try {
      const storeId = getStoreId();
      const storeInfo = await getStoreInfo(storeId);
      event.reply('store-info-response', storeInfo);
    } catch (error) {
      console.error(`[ERROR] Error fetching store info: ${error.message}`);
      event.reply('store-info-response', { 
        success: false, 
        error: '매장 정보를 불러오는 중 오류가 발생했습니다.' 
      });
    }
  });
  
  // 현재 매장 ID 요청 처리
  ipcMain.on('get-current-store-id', (event) => {
    event.reply('current-store-id', getStoreId());
  });
  
  // 매장 ID 유효성 검사 처리
  ipcMain.on('validate-store-id', async (event, storeId) => {
    try {
      const storeInfo = await getStoreInfo(storeId);
      event.reply('validate-store-id-response', storeInfo);
    } catch (error) {
      console.error(`[ERROR] Error validating store ID: ${error.message}`);
      event.reply('validate-store-id-response', { 
        success: false, 
        error: '매장 ID 검증 중 오류가 발생했습니다.' 
      });
    }
  });
  
  // 매장 ID 저장 처리
  ipcMain.on('save-store-id', (event, storeId) => {
    try {
      const result = saveStoreId(storeId);
      event.reply('save-store-id-response', { success: result });
    } catch (error) {
      console.error(`[ERROR] Error saving store ID: ${error.message}`);
      event.reply('save-store-id-response', { 
        success: false, 
        error: '매장 ID 저장 중 오류가 발생했습니다.' 
      });
    }
  });
  
  // 로그인 상태 요청 처리
  ipcMain.on('get-login-status', (event) => {
    try {
      const { hasCredentials } = getUserCredentials();
      event.reply('login-status-response', hasCredentials);
    } catch (error) {
      console.error(`[ERROR] Error getting login status: ${error.message}`);
      event.reply('login-status-response', false);
    }
  });
  
  // 계정 정보 요청 처리
  ipcMain.on('get-credentials', (event) => {
    try {
      const credentials = getUserCredentials();
      event.reply('credentials-response', credentials);
    } catch (error) {
      console.error(`[ERROR] Error getting credentials: ${error.message}`);
      event.reply('credentials-response', { 
        phone: '', 
        password: '', 
        hasCredentials: false 
      });
    }
  });
  
  // 계정 정보 저장 처리
  ipcMain.on('save-credentials', (event, { phone, password }) => {
    try {
      const result = saveUserCredentials(phone, password);
      event.reply('save-credentials-response', { success: result });
    } catch (error) {
      console.error(`[ERROR] Error saving credentials: ${error.message}`);
      event.reply('save-credentials-response', { success: false });
    }
  });
  
  // 계정 정보 삭제 처리
  ipcMain.on('clear-credentials', (event) => {
    try {
      const result = clearUserCredentials();
      event.reply('clear-credentials-response', { success: result });
    } catch (error) {
      console.error(`[ERROR] Error clearing credentials: ${error.message}`);
      event.reply('clear-credentials-response', { success: false });
    }
  });
  
  // 앱 재시작 요청 처리
  ipcMain.on('restart-app', () => {
    app.relaunch();
    app.exit(0);
  });
}

process.on('uncaughtException', (error) => {
  console.error('[CRITICAL] Uncaught exception:', error);
  updateAppStatus('오류 발생');
  // 프로세스는 계속 실행
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled rejection at:', promise, 'reason:', reason);
  updateAppStatus('오류 발생');
  // 프로세스는 계속 실행
});

// IPC 핸들러 설정
setupIpcHandlers();

// 메인 프로세스 시작
main().catch(error => {
  console.error('[ERROR] Main process failed:', error);
  updateAppStatus('시작 오류');
  app.quit();
});
