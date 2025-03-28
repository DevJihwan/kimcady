const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

// 환경 변수
const STORE_ID = '6690d7ea750ff9a6689e9af3';

// 윈도우에서 실행 파일 확인
if (process.platform === 'win32') {
  console.log(`Running on Windows. App path: ${app.getPath('exe')}`);
  console.log(`Desktop path: ${app.getPath('desktop')}`);
}

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
  const url = `https://api.dev.24golf.co.kr/auth/token/stores/${STORE_ID}/role/singleCrawler`;
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
    const match = part.match(/name=\"([^\"]+)\"\\r\\n\\r\\n(.+?)(?=\\r\\n|$)/);
    if (match) {
      const [, key, value] = match;
      result[key] = value;
    }
  });
  return result;
};

// 24golf API로 데이터 전송
const sendTo24GolfApi = async (type, url, payload, response = null, accessToken, processedBookings = new Set()) => {
  // 중복 호출 방지
  if (type === 'Booking_Create' && response && response.book_id && processedBookings.has(response.book_id)) {
    console.log(`[INFO] Booking_Create already processed for book_id: ${response.book_id}, skipping...`);
    return;
  }

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
    // 처리된 book_id 기록
    if (type === 'Booking_Create' && response && response.book_id) {
      processedBookings.add(response.book_id);
    }
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
  // 화면 크기 가져오기
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  console.log(`[INFO] Screen dimensions: ${width}x${height}`);

  // 창 생성 시 전체 화면으로 설정
  const win = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false // 준비되기 전까지 보이지 않게 설정
  });

  // 창 로드 완료 후 표시
  win.once('ready-to-show', () => {
    win.show();
    win.maximize(); // 창 최대화
    console.log('[INFO] Electron window maximized');
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
        '--start-maximized', // 최대화된 창으로 시작
        `--window-size=${width},${height}`, // 실제 화면 크기로 설정
        '--window-position=0,0',
        '--disable-notifications', // 알림 비활성화
        '--disable-infobars' // 정보 표시줄 비활성화
      ],
      defaultViewport: null // 뷰포트 자동 조정 허용
    });

    // 브라우저 페이지 가져오기 및 크기 조정
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    // 뷰포트 크기 설정
    await page.setViewport({
      width: width,
      height: height,
      deviceScaleFactor: 1
    });

    // 브라우저 창 최대화
    try {
      // 창 최대화 시도 1
      await page._client.send('Browser.setWindowBounds', {
        windowId: 1,
        bounds: { windowState: 'maximized' }
      });
    } catch (e) {
      console.log('[DEBUG] First maximize method failed, trying alternative method');
      
      // 창 최대화 시도 2
      await page.evaluate(() => {
        window.moveTo(0, 0);
        window.resizeTo(window.screen.availWidth, window.screen.availHeight);
        if (window.screen) {
          window.moveTo(0, 0);
          window.resizeTo(
            window.screen.availWidth,
            window.screen.availHeight
          );
        }
      });
    }

    // 사이트 접속
    await page.goto('https://owner.kimcaddie.com/', { 
      waitUntil: 'networkidle2',
      timeout: 60000 // 타임아웃 60초로 설정
    });

    console.log('[INFO] Browser launched and navigated to kimcaddie site');

    const requestMap = new Map();
    const bookingIds = new Map();
    const processedBookings = new Set(); // 중복 호출 방지용
    let immediateBookable = false; // 즉시 확정 여부
    const pendingCustomerRequests = new Map(); // 고객 요청 대기 목록

    // API 요청 감지
    page.on('request', async (request) => {
      const url = request.url();
      const method = request.method();
      const postData = request.postData();
      const headers = request.headers();

      if (url.startsWith('https://api.kimcaddie.com/api/') && method === 'POST') {
        console.log(`[DEBUG] POST Request Detected - URL: ${url}, Data: ${postData}`);
      }

      if (url.startsWith('https://api.kimcaddie.com/api/')) {
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

        // 매장 정보 요청 감지
        if (url.includes('/owner/shop/-/') && method === 'GET') {
          //console.log(`[DEBUG] Shop Info Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Shop_Info' });
        }
        // 고객 요청 감지
        else if (url.includes('/owner/customer/') && method === 'GET') {
          console.log(`[DEBUG] Customer Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Customer_Request' });
        }
        // 예약 목록 요청 감지
        else if (url.includes('/owner/booking/') && method === 'GET') {
          //console.log(`[DEBUG] Booking List Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Booking_List' });
        }
        // 직접 예약 등록 요청 감지
        else if (url.includes('/owner/booking') && method === 'POST') {
          console.log(`[DEBUG] Booking_Create Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Booking_Create' });
        }
        // 예약 수정 요청 감지
        else if (url.includes('/booking/change_info') && method === 'PATCH' && (!payload.state || payload.state !== 'canceled')) {
          const bookingId = url.split('/').pop().split('?')[0];
          payload.externalId = bookingId;
          await sendTo24GolfApi('Booking_Update', url, payload, null, accessToken, processedBookings);
        }
        // 예약 취소 요청 감지
        else if (url.includes('/booking/change_info') && method === 'PATCH' && payload.state === 'canceled') {
          const bookingId = url.split('/').pop().split('?')[0];
          payload.externalId = bookingId;
          await sendTo24GolfApi('Booking_Cancel', url, payload, null, accessToken, processedBookings);
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

      // 매장 정보 응답 처리
      if (url.includes('/owner/shop/-/') && status === 200 && method === 'GET') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Shop_Info') {
          try {
            const responseData = await response.json();
            console.log(`[DEBUG] Shop Info Response Data:`, JSON.stringify(responseData, null, 2));
            immediateBookable = responseData.immediate_bookable || false;
            console.log(`[INFO] Immediate Bookable: ${immediateBookable}`);
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
      }

      // 고객 요청 응답 처리
      if (url.includes('/owner/customer/') && status === 200 && method === 'GET') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Customer_Request') {
          try {
            const responseData = await response.json();
            //console.log(`[DEBUG] Customer Request Response Data:`, JSON.stringify(responseData, null, 2));
            if (immediateBookable) {
              const customerId = responseData.id;
              const requestTime = new Date(); // 요청 시간 기록
              pendingCustomerRequests.set(customerId, { requestTime });
              console.log(`[INFO] Immediate booking detected for customer ${customerId}. Waiting for booking details...`);
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
      }

      // 예약 목록 응답 처리
      if (url.includes('/owner/booking/') && status === 200 && method === 'GET') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Booking_List') {
          try {
            const responseData = await response.json();
            //console.log(`[DEBUG] Booking List Response Data:`, JSON.stringify(responseData, null, 2));

            // 예약 목록 순회
            if (responseData.results && Array.isArray(responseData.results)) {
              for (const booking of responseData.results) {
                const customerId = booking.customer;
                if (pendingCustomerRequests.has(customerId)) {
                  const { requestTime } = pendingCustomerRequests.get(customerId);
                  const bookingTime = new Date(booking.reg_date);
                  // 고객 요청 이후 생성된 예약인지 확인
                  if (bookingTime >= requestTime && (booking.immediate_booked || booking.state === 'success')) {
                    console.log(`[INFO] Found booking for customer ${customerId}: book_id ${booking.book_id}`);
                    const payload = {
                      start_datetime: booking.start_datetime,
                      end_datetime: booking.end_datetime,
                      person: booking.person,
                      room: booking.room
                    };
                    const responseForBooking = {
                      book_id: booking.book_id,
                      name: booking.name,
                      phone: booking.phone,
                      is_paid: booking.is_paid
                    };
                    await sendTo24GolfApi('Booking_Create', url, payload, responseForBooking, accessToken, processedBookings);
                    pendingCustomerRequests.delete(customerId); // 처리 완료 후 제거
                  }
                }
              }
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
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

          await sendTo24GolfApi('Booking_Create', url, requestData.payload, responseData, accessToken, processedBookings);
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

            const bookingInfo = responseData.bookingInfo;
            if (bookingInfo && bookingInfo.state === 'confirmed') {
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
              await sendTo24GolfApi('Booking_Create', url, payload, responseForBooking, accessToken, processedBookings);
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
      }
    });

    // 페이지 로드 완료 후 추가 최대화 스크립트 실행
    page.on('load', async () => {
      console.log('[INFO] Page loaded, applying maximization...');
      await page.evaluate(() => {
        document.documentElement.style.overflow = 'auto';
        document.body.style.overflow = 'auto';
        if (window.screen) {
          window.moveTo(0, 0);
          window.resizeTo(
            window.screen.availWidth,
            window.screen.availHeight
          );
        }
      });
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