const { app, BrowserWindow } = require('electron');
const path = require('path');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

// 환경 변수
const STORE_ID = '6690d7ea750ff9a6689e9af3';

let CHROME_PATH;
if (process.platform === 'win32') {
  CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!fs.existsSync(CHROME_PATH)) {
    CHROME_PATH = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
  }
} else if (process.platform === 'darwin') {
  CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
} else {
  CHROME_PATH = '/usr/bin/google-chrome';
}

// access_token 발급 함수
const getAccessToken = async () => {
  const url = `https://api.dev.24golf.co.kr/auth/token/store/${STORE_ID}/role/singleCrawler`;
  console.log(`[Token] Attempting to fetch access token from: ${url}`);

  try {
    const response = await axios.get(url, {
      headers: { 'Content-Type': 'application/json' },
    });
    const accessToken = response.data;
    console.log('[Token] Successfully obtained access token:', accessToken);
    return accessToken;
  } catch (error) {
    console.error('[Token Error] Failed to obtain access token:', error.message);
    if (error.response) {
      console.error('[Token Error] Response status:', error.response.status);
      console.error('[Token Error] Response data:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
};

// multipart/form-data를 파싱하는 함수
const parseMultipartFormData = (data) => {
  const result = {};
  const boundary = data.match(/------WebKitFormBoundary[a-zA-Z0-9]+/)[0];
  const parts = data.split(boundary).slice(1, -1);

  parts.forEach(part => {
    const match = part.match(/name="([^"]+)"\r\n\r\n(.+?)(?=\r\n|$)/);
    if (match) {
      const [, key, value] = match;
      result[key] = value;
    }
  });
  return result;
};

// 24golf API로 데이터 전송
const sendTo24GolfApi = async (type, url, payload, response = null, accessToken) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${type} - URL: ${url} - Payload: ${JSON.stringify(payload)} - Response: ${response ? JSON.stringify(response) : 'N/A'}\n`;
  console.log(logMessage);

  let apiMethod, apiUrl, apiData;
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  if (type === 'Booking_Create' && response) {
    apiMethod = 'POST';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = {
      externalId: response.book_id || 'unknown',
      name: response.name || 'Unknown',
      phone: response.phone || '010-0000-0000',
      partySize: parseInt(payload.person, 10) || 1,
      startDate: payload.start_datetime ? payload.start_datetime.replace('+09:00', 'Z') : new Date().toISOString(),
      endDate: payload.end_datetime ? payload.end_datetime.replace('+09:00', 'Z') : new Date().toISOString(),
      roomId: payload.room_id || payload.room || 'unknown',
      paymented: response.is_paid || false,
      paymentAmount: 0,
      crawlingSite: 'KimCaddie'
    };
  } else if (type === 'Booking_Update') {
    apiMethod = 'PATCH';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = {
      externalId: payload.externalId || 'unknown',
      name: 'Unknown',
      phone: '010-0000-0000',
      partySize: parseInt(payload.person, 10) || 1,
      startDate: payload.start_datetime ? payload.start_datetime.replace('+09:00', 'Z') : new Date().toISOString(),
      endDate: payload.end_datetime ? payload.end_datetime.replace('+09:00', 'Z') : new Date().toISOString(),
      roomId: payload.room_id || 'unknown',
      paymented: false,
      paymentAmount: 0,
      crawlingSite: 'KimCaddie'
    };
  } else if (type === 'Booking_Cancel') {
    apiMethod = 'DELETE';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;
    apiData = {
      externalId: payload.externalId || 'unknown',
      crawlingSite: 'KimCaddie',
      reason: payload.canceled_by || 'Canceled by Manager'
    };
  }

  // 요청 본문 검증
  if (type === 'Booking_Cancel') {
    if (apiData && (apiData.externalId === 'unknown' || !apiData.crawlingSite)) {
      console.error(`[Validation Error] Missing required fields for ${type}:`, apiData);
      return;
    }
  } else {
    if (apiData && (apiData.externalId === 'unknown' || !apiData.crawlingSite || !apiData.name || !apiData.phone || !apiData.partySize || !apiData.startDate || !apiData.endDate || !apiData.roomId)) {
      console.error(`[Validation Error] Missing required fields for ${type}:`, apiData);
      return;
    }
  }

  try {
    console.log(`[API Request] Sending ${type} to ${apiUrl} with data:`, JSON.stringify(apiData, null, 2));
    let apiResponse;
    if (apiMethod === 'DELETE') {
      apiResponse = await axios.delete(apiUrl, { headers, data: apiData });
    } else {
      apiResponse = await axios({
        method: apiMethod,
        url: apiUrl,
        headers,
        data: apiData
      });
    }
    console.log(`[API] Successfully sent ${type}: ${apiResponse.status}`);
  } catch (error) {
    console.error(`[API Error] Failed to send ${type}: ${error.message}`);
    if (error.response) {
      console.error(`[API Error] Response status: ${error.response.status}`);
      console.error(`[API Error] Response data:`, JSON.stringify(error.response.data, null, 2));
    }
  }
};

// Electron 창 생성
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile('index.html');

  // Puppeteer 실행
  (async () => {
    let accessToken;
    try {
      accessToken = await getAccessToken();
    } catch (error) {
      console.error('Failed to start due to token error. Exiting...');
      app.quit();
      return;
    }

    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1280,720',
        '--window-position=0,0'
      ],
      defaultViewport: null
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 1280,
      height: 720,
      deviceScaleFactor: 1
    });

    await page.evaluate(() => {
      window.moveTo(0, 0);
      window.resizeTo(screen.availWidth, screen.availHeight);
    });

    await page.goto('https://owner.kimcaddie.com/', { waitUntil: 'networkidle2' });

    const requestMap = new Map();
    const bookingIds = new Map();

    // API 요청 감지
    page.on('request', async (request) => {
      const url = request.url();
      const method = request.method();
      const postData = request.postData();
      const headers = request.headers();

      if (url.startsWith('https://api.kimcaddie.com/api/') && method === 'POST') {
        console.log(`[DEBUG] POST Request Detected - URL: ${url}, Data: ${postData}`);
      }

      if (url.startsWith('https://api.kimcaddie.com/api/') && (method === 'POST' || method === 'PATCH')) {
        let payload = {};
        const contentType = headers['content-type'] || '';
        if (contentType.includes('multipart/form-data') && postData) {
          payload = parseMultipartFormData(postData);
        } else if (contentType.includes('application/json') && postData) {
          try {
            payload = JSON.parse(postData);
          } catch (e) {
            payload = postData;
          }
        } else {
          payload = postData || {};
        }

        // 직접 예약 등록 요청 감지
        if (url.includes('/owner/booking') && method === 'POST') {
          console.log(`[DEBUG] Booking_Create Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Booking_Create' });
        }
        // 예약 수정 요청 감지
        else if (url.includes('/booking/change_info') && method === 'PATCH' && (!payload.state || payload.state !== 'canceled')) {
          const bookingId = url.split('/').pop().split('?')[0];
          payload.externalId = bookingId;
          await sendTo24GolfApi('Booking_Update', url, payload, null, accessToken);
        }
        // 예약 취소 요청 감지
        else if (url.includes('/booking/change_info') && method === 'PATCH' && payload.state === 'canceled') {
          const bookingId = url.split('/').pop().split('?')[0];
          payload.externalId = bookingId;
          await sendTo24GolfApi('Booking_Cancel', url, payload, null, accessToken);
        }
        // 사장님 수락 요청 감지
        else if (url.includes('/booking/confirm_state') && method === 'PATCH') {
          console.log(`[DEBUG] Booking_Confirm Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Booking_Confirm' });
        }
      }
    });

    // API 응답 감지
    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      const request = response.request();
      const method = request.method();

      if (url.startsWith('https://api.kimcaddie.com/api/') && method === 'POST') {
        console.log(`[DEBUG] POST Response Detected - URL: ${url}, Status: ${status}`);
      }

      // 직접 예약 등록 응답 처리
      if (url.includes('/owner/booking') && status === 200 && method === 'POST') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Booking_Create') {
          let responseData;
          try {
            responseData = await response.json();
            console.log(`[DEBUG] Booking_Create Response Data:`, JSON.stringify(responseData, null, 2));
            if (responseData.book_id) {
              bookingIds.set(responseData.book_id, responseData);
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
            responseData = null;
          }

          await sendTo24GolfApi('Booking_Create', url, requestData.payload, responseData, accessToken);
          requestMap.delete(url);
        }
      }

      // 사장님 수락 응답 처리
      if (url.includes('/booking/confirm_state') && status === 200 && method === 'PATCH') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Booking_Confirm') {
          let responseData;
          try {
            responseData = await response.json();
            console.log(`[DEBUG] Booking_Confirm Response Data:`, JSON.stringify(responseData, null, 2));

            // bookingInfo에서 필요한 데이터 추출
            const bookingInfo = responseData.bookingInfo;
            if (bookingInfo && bookingInfo.state === 'confirmed') {
              // Booking_Create API 호출
              const payload = {
                start_datetime: bookingInfo.start_datetime,
                end_datetime: bookingInfo.end_datetime,
                person: bookingInfo.person,
                room: bookingInfo.room
              };
              const responseForBooking = {
                book_id: bookingInfo.book_id,
                name: bookingInfo.name,
                phone: bookingInfo.phone,
                is_paid: bookingInfo.is_paid
              };
              await sendTo24GolfApi('Booking_Create', url, payload, responseForBooking, accessToken);
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
      }
    });

    console.log('브라우저가 열렸습니다. 로그인 및 예약 관리를 진행해주세요.');
  })();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
    app.quit();
});