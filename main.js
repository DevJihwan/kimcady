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

const parseMultipartFormData = (data) => {
  const result = {};
  const boundary = data.match(/------WebKitFormBoundary[a-zA-Z0-9]+/)[0];
  const parts = data.split(boundary).slice(1, -1);

  parts.forEach(part => {
    const match = part.match(/name=\"([^\"]+)\"[\r\n]+([\s\S]+?)(?=\r\n|$)/);
    if (match) {
      const [, key, value] = match;
      result[key] = value.trim();
    }
  });
  console.log('[DEBUG] Parsed multipart/form-data:', JSON.stringify(result, null, 2));
  return result;
};

// 24golf API로 데이터 전송
const sendTo24GolfApi = async (
  type,
  url,
  payload,
  response = null,
  accessToken,
  processedBookings = new Set(),
  paymentAmounts = new Map(),
  paymentStatus = new Map()
) => {
  if (type === 'Booking_Create' && response && response.book_id && processedBookings.has(response.book_id)) {
    console.log(`[INFO] Booking_Create already processed for book_id: ${response.book_id}, skipping...`);
    return;
  }

  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${type} - URL: ${url} - Payload: ${JSON.stringify(payload)} - Response: ${response ? JSON.stringify(response) : 'N/A'}\n`;
  console.log(logMessage);

  let apiMethod, apiUrl, apiData;
  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  const bookId = response?.book_id || payload?.externalId || 'unknown';
  const paymentAmount = paymentAmounts.has(bookId) ? paymentAmounts.get(bookId) : 0;
  const isPaymentCompleted = paymentStatus.has(bookId) ? paymentStatus.get(bookId) : false;

  if (type === 'Booking_Create' && response) {
    apiMethod = 'POST';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;

    const roomId = response.room || (payload && payload.room) || null;
    let startDateTime = response.start_datetime || (payload && payload.start_datetime) || null;
    let endDateTime = response.end_datetime || (payload && payload.end_datetime) || null;

    if (startDateTime) {
      if (!startDateTime.includes('Z') && !startDateTime.includes('+')) {
        startDateTime = `${startDateTime}+09:00`;
      }
    } else {
      const now = new Date();
      startDateTime = new Date(now.getTime() + (9 * 60 * 60 * 1000)).toISOString().replace('Z', '+09:00');
    }

    if (endDateTime) {
      if (!endDateTime.includes('Z') && !endDateTime.includes('+')) {
        endDateTime = `${endDateTime}+09:00`;
      }
    } else {
      if (startDateTime && startDateTime !== new Date().toISOString()) {
        let endDate;
        if (startDateTime.includes('+09:00')) {
          endDate = new Date(startDateTime.replace('+09:00', 'Z'));
          endDate.setHours(endDate.getHours() + 1);
          endDateTime = endDate.toISOString().replace('Z', '+09:00');
        } else {
          endDate = new Date(startDateTime);
          endDate.setHours(endDate.getHours() + 1);
          endDateTime = endDate.toISOString().replace('Z', '+09:00');
        }
      } else {
        const now = new Date();
        endDateTime = new Date(now.getTime() + (10 * 60 * 60 * 1000)).toISOString().replace('Z', '+09:00');
      }
    }

    apiData = {
      externalId: bookId,
      name: response.name || 'Unknown',
      phone: response.phone || '010-0000-0000',
      partySize: parseInt(response.person || payload.person || 1, 10),
      startDate: startDateTime,
      endDate: endDateTime,
      roomId: roomId ? roomId.toString() : 'unknown',
      paymented: isPaymentCompleted,
      paymentAmount: paymentAmount,
      crawlingSite: 'KimCaddie'
    };

    console.log(`[DEBUG] Extracted data for API request:
    - roomId: ${roomId} (from: ${response.room ? 'response.room' : payload.room ? 'payload.room' : 'not found'})
    - startDate: ${startDateTime} (from: ${response.start_datetime ? 'response.start_datetime' : payload.start_datetime ? 'payload.start_datetime' : 'current time'})
    - endDate: ${endDateTime} (from: ${response.end_datetime ? 'response.end_datetime' : payload.end_datetime ? 'payload.end_datetime' : 'calculated'})
    - paymented: ${isPaymentCompleted} (from: paymentStatus Map)
    - paymentAmount: ${paymentAmount} (from: paymentAmounts Map)`);
  } else if (type === 'Booking_Update') {
    apiMethod = 'PATCH';
    apiUrl = `https://api.dev.24golf.co.kr/stores/${STORE_ID}/reservation/crawl`;

    let startDateTime = payload.start_datetime || null;
    let endDateTime = payload.end_datetime || null;
    const roomId = payload.room_id || payload.room || 'unknown';

    if (payload.start_datetime) {
      startDateTime = payload.start_datetime;
    } else {
      const now = new Date();
      startDateTime = new Date(now.getTime() + (9 * 60 * 60 * 1000)).toISOString().replace('Z', '+09:00');
    }

    if (payload.end_datetime) {
      endDateTime = payload.end_datetime;
    } else {
      let endDate;
      if (startDateTime.includes('+09:00')) {
        endDate = new Date(startDateTime.replace('+09:00', 'Z'));
        endDate.setHours(endDate.getHours() + 1);
        endDateTime = endDate.toISOString().replace('Z', '+09:00');
      } else {
        endDate = new Date(startDateTime);
        endDate.setHours(endDate.getHours() + 1);
        endDateTime = endDate.toISOString().replace('Z', '+09:00');
      }
    }

    if (startDateTime && !startDateTime.includes('Z') && !startDateTime.includes('+')) {
      startDateTime = `${startDateTime}+09:00`;
    }

    if (endDateTime && !endDateTime.includes('Z') && !endDateTime.includes('+')) {
      endDateTime = `${endDateTime}+09:00`;
    }

    const name = payload.name || 'Unknown';
    const phone = payload.phone || '010-0000-0000';

    apiData = {
      externalId: bookId,
      name: name,
      phone: phone,
      partySize: parseInt(payload.person, 10) || 1,
      startDate: startDateTime,
      endDate: endDateTime,
      roomId: roomId,
      paymented: isPaymentCompleted,
      paymentAmount: paymentAmount,
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

  if (type === 'Booking_Cancel') {
    if (apiData && (apiData.externalId === 'unknown' || !apiData.crawlingSite)) {
      console.error(`[Validation Error] Missing required fields for ${type}:`, apiData);
      return;
    }
  } else {
    if (apiData && (
      apiData.externalId === 'unknown' || 
      !apiData.crawlingSite || 
      !apiData.name || 
      !apiData.phone || 
      !apiData.partySize || 
      !apiData.startDate || 
      !apiData.endDate || 
      !apiData.roomId
    )) {
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
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  
  console.log(`[INFO] Screen dimensions: ${width}x${height}`);

  const win = new BrowserWindow({
    width: width,
    height: height,
    x: 0,
    y: 0,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
  });

  win.once('ready-to-show', () => {
    win.show();
    win.maximize();
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
        '--start-maximized',
        `--window-size=${width},${height}`,
        '--window-position=0,0',
        '--disable-notifications',
        '--disable-infobars'
      ],
      defaultViewport: null
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    await page.setViewport({
      width: width,
      height: height,
      deviceScaleFactor: 1
    });

    try {
      await page._client.send('Browser.setWindowBounds', {
        windowId: 1,
        bounds: { windowState: 'maximized' }
      });
    } catch (e) {
      console.log('[DEBUG] First maximize method failed, trying alternative method');
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

    await page.goto('https://owner.kimcaddie.com/', { 
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('[INFO] Browser launched and navigated to kimcaddie site');

    const requestMap = new Map();
    const bookingIds = new Map();
    const processedBookings = new Set();
    let immediateBookable = false;
    const pendingCustomerRequests = new Map();
    const paymentAmounts = new Map();
    const paymentStatus = new Map();
    const bookIdToIdxMap = new Map();
    const bookingDataMap = new Map();

    // 타임아웃 설정 (5분)
    const TIMEOUT_MS = 5 * 60 * 1000;
    setInterval(() => {
      const now = new Date();
      for (const [customerId, { requestTime }] of pendingCustomerRequests.entries()) {
        if (now - requestTime > TIMEOUT_MS) {
          console.log(`[INFO] Timeout: Removing pending customer request for customer ${customerId}`);
          pendingCustomerRequests.delete(customerId);
        }
      }
      for (const [bookId, { timestamp }] of bookingDataMap.entries()) {
        if (now - timestamp > TIMEOUT_MS) {
          console.log(`[INFO] Timeout: Removing pending booking data for book_id ${bookId}`);
          bookingDataMap.delete(bookId);
        }
      }
    }, 60000);

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
            console.error(`[ERROR] Failed to parse JSON payload: ${e.message}`);
            payload = postData;
          }
        } else {
          payload = postData || {};
        }

        if (url.includes('/owner/revenue/') && method === 'POST') {
          const bookIdx = payload.book_idx;
          const amount = payload.amount ? parseInt(payload.amount, 10) : undefined;
          const finished = payload.finished === 'true';

          if (bookIdx) {
            let bookId = null;
            for (const [bId, bIdx] of bookIdToIdxMap.entries()) {
              if (bIdx === bookIdx) {
                bookId = bId;
                break;
              }
            }

            if (bookId) {
              if (amount !== undefined) {
                paymentAmounts.set(bookId, amount);
                console.log(`[INFO] Updated payment amount for book_id ${bookId} (book_idx ${bookIdx}) to ${amount} (from /owner/revenue/ postData)`);
              }
              if (finished !== undefined) {
                paymentStatus.set(bookId, finished);
                console.log(`[INFO] Stored payment status for book_id ${bookId} (book_idx ${bookIdx}): ${finished} (from /owner/revenue/ postData)`);
              }
              console.log(`[DEBUG] Current paymentAmounts:`, Array.from(paymentAmounts.entries()));
              console.log(`[DEBUG] Current paymentStatus:`, Array.from(paymentStatus.entries()));
            } else {
              console.log(`[WARN] No book_id found for book_idx ${bookIdx}`);
            }
          }
        }

        if (url.includes('/owner/shop/-/') && method === 'GET') {
          requestMap.set(url, { method, payload, type: 'Shop_Info' });
        } else if (url.includes('/owner/customer/') && method === 'GET') {
          console.log(`[DEBUG] Customer Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Customer_Request' });
        } else if (url.includes('/owner/booking/') && method === 'GET') {
          requestMap.set(url, { method, payload, type: 'Booking_List' });
        } else if (url.includes('/owner/booking') && method === 'POST') {
          console.log(`[DEBUG] Booking_Create Request Captured - URL: ${url}`);
          requestMap.set(url, { method, payload, type: 'Booking_Create' });
        }else if (url.includes('/booking/change_info') && method === 'PATCH' && (!payload.state || payload.state !== 'canceled')) {
            const bookingId = url.split('/').pop().split('?')[0];
            payload.externalId = bookingId;
            console.log(`[DEBUG] Booking_Update Full Payload:`, JSON.stringify(payload, null, 2));
      
            // HTML에서 결제 정보 수집
            let paymentAmountFromDom = 0;
            let paymentStatusFromDom = false;
            try {
              // 이용 금액 수집
              await page.waitForSelector('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', { timeout: 5000 });
              const paymentAmountText = await page.$eval('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', el => el.textContent.trim());
              paymentAmountFromDom = parseInt(paymentAmountText.replace(/[^0-9]/g, ''), 10);
              console.log(`[INFO] Extracted payment amount from DOM: ${paymentAmountFromDom}`);
      
              // 결제 완료 체크박스 상태 수집
              await page.waitForSelector('.MuiFormControlLabel-root', { timeout: 5000 }); // 체크박스 상위 요소 대기
              // DOM 업데이트가 반영될 때까지 약간의 지연 추가
              await new Promise(resolve => setTimeout(resolve, 500)); // 0.5초 대기
              paymentStatusFromDom = await page.evaluate(() => {
                const checkbox = document.querySelector('.PrivateSwitchBase-input.css-1m9pwf3');
                return checkbox ? checkbox.checked : false;
              });
              console.log(`[INFO] Extracted payment status from DOM (via evaluate): ${paymentStatusFromDom}`);
      
              // 추가 디버깅: 체크박스 상태와 클래스 확인
              const hasCheckedClass = await page.evaluate(() => {
                return document.querySelector('.MuiCheckbox-root')?.classList.contains('Mui-checked');
              });
              console.log(`[DEBUG] Mui-checked class exists: ${hasCheckedClass}`);
              if (hasCheckedClass !== paymentStatusFromDom) {
                console.warn(`[WARN] Inconsistent payment status: checked=${paymentStatusFromDom}, Mui-checked=${hasCheckedClass}`);
                paymentStatusFromDom = hasCheckedClass; // 클래스 기반으로 보정
              }
            } catch (e) {
              console.error(`[ERROR] Failed to extract payment info from DOM: ${e.message}`);
              paymentAmountFromDom = 0;
              paymentStatusFromDom = false;
            }
      
            // DOM에서 수집한 값으로 paymentAmounts와 paymentStatus 업데이트
            paymentAmounts.set(bookingId, paymentAmountFromDom);
            paymentStatus.set(bookingId, paymentStatusFromDom);
      
            // 즉시 Booking_Update 호출
            await sendTo24GolfApi(
              'Booking_Update',
              url,
              payload,
              null,
              accessToken,
              processedBookings,
              paymentAmounts,
              paymentStatus
            );
            console.log(`[INFO] Processed Booking_Update for book_id ${bookingId} with DOM data`);
          }else if (url.includes('/booking/change_info') && method === 'PATCH' && payload.state === 'canceled') {
          const bookingId = url.split('/').pop().split('?')[0];
          payload.externalId = bookingId;
          await sendTo24GolfApi('Booking_Cancel', url, payload, null, accessToken, processedBookings);
        } else if (url.includes('/booking/confirm_state') && method === 'PATCH') {
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

      if (url.includes('/owner/revenue/') && status === 200 && method === 'POST') {
        try {
          const responseData = await response.json();
          console.log(`[DEBUG] Revenue Response Data:`, JSON.stringify(responseData, null, 2));
          const postData = request.postData();
          let payload = {};
          const contentType = request.headers()['content-type'] || '';
          if (contentType.includes('multipart/form-data') && postData) {
            payload = parseMultipartFormData(postData);
          } else if (contentType.includes('application/json') && postData) {
            payload = JSON.parse(postData);
          }

          const bookIdx = payload.book_idx;
          const amount = payload.amount ? parseInt(payload.amount, 10) : undefined;
          const finished = responseData.finished !== undefined ? responseData.finished : payload.finished === 'true';

          if (bookIdx) {
            let bookId = null;
            for (const [bId, bIdx] of bookIdToIdxMap.entries()) {
              if (bIdx === bookIdx) {
                bookId = bId;
                break;
              }
            }

            if (bookId) {
              if (amount !== undefined) {
                paymentAmounts.set(bookId, amount);
                console.log(`[INFO] Updated payment amount for book_id ${bookId} (book_idx ${bookIdx}) to ${amount} (from /owner/revenue/ response)`);
              }
              if (finished !== undefined) {
                paymentStatus.set(bookId, finished);
                console.log(`[INFO] Stored payment status for book_id ${bookId} (book_idx ${bookIdx}): ${finished} (from /owner/revenue/ response)`);
              }
              console.log(`[DEBUG] Current paymentAmounts:`, Array.from(paymentAmounts.entries()));
              console.log(`[DEBUG] Current paymentStatus:`, Array.from(paymentStatus.entries()));

              if (bookingDataMap.has(bookId)) {
                const { type, payload } = bookingDataMap.get(bookId);
                console.log(`[DEBUG] Found pending ${type} data for book_id ${bookId} in bookingDataMap`);
                if (type === 'Booking_Create') {
                  const { response: bookingResponse } = bookingDataMap.get(bookId);
                  await sendTo24GolfApi(
                    'Booking_Create',
                    url,
                    payload,
                    bookingResponse,
                    accessToken,
                    processedBookings,
                    paymentAmounts,
                    paymentStatus
                  );
                  console.log(`[INFO] Processed Booking_Create for book_id ${bookId} after revenue update`);
                  bookingDataMap.delete(bookId);
                }
              }
            } else {
              console.log(`[WARN] No book_id found for book_idx ${bookIdx}`);
            }
          } else {
            console.log(`[WARN] book_idx missing in /owner/revenue/ payload:`, JSON.stringify(payload, null, 2));
          }
        } catch (e) {
          console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
        }
      }

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

      if (url.includes('/owner/customer/') && status === 200 && method === 'GET') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Customer_Request') {
          try {
            const responseData = await response.json();
            console.log(`[DEBUG] Customer Request Response Data:`, JSON.stringify(responseData, null, 2));
            if (immediateBookable) {
              const customerId = responseData.id;
              const customerName = responseData.name;
              const customerPhone = responseData.phone;
              const requestTime = new Date();
              pendingCustomerRequests.set(customerId, { 
                requestTime, 
                customerName, 
                customerPhone 
              });
              console.log(`[INFO] Immediate booking detected for customer ${customerId}. Waiting for booking details...`);
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
      }

      if (url.includes('/owner/booking/') && status === 200 && method === 'GET') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Booking_List') {
          try {
            const responseData = await response.json();
            if (responseData.results && Array.isArray(responseData.results)) {
              for (const [customerId, customerData] of pendingCustomerRequests.entries()) {
                const { requestTime, customerName, customerPhone } = customerData;
                const matchingBookings = responseData.results.filter(booking => 
                  booking.customer === customerId && 
                  (booking.immediate_booked || booking.state === 'success')
                );

                if (matchingBookings.length > 0) {
                  const latestBooking = matchingBookings.reduce((latest, booking) => {
                    const bookingTime = new Date(booking.reg_date);
                    const latestTime = latest ? new Date(latest.reg_date) : new Date(0);
                    return bookingTime > latestTime ? booking : latest;
                  }, null);

                  const bookingTime = new Date(latestBooking.reg_date);
                  const timeDiff = Math.abs(bookingTime - requestTime) / 1000 / 60;
                  if (timeDiff <= 5) {
                    console.log(`[INFO] Found latest booking for customer ${customerId}: book_id ${latestBooking.book_id}`);
                    const payload = {
                      start_datetime: latestBooking.start_datetime,
                      end_datetime: latestBooking.end_datetime,
                      person: latestBooking.person,
                      room: latestBooking.room
                    };
                    const responseForBooking = {
                      book_id: latestBooking.book_id,
                      name: customerName,
                      phone: customerPhone,
                      is_paid: latestBooking.is_paid,
                      room: latestBooking.room
                    };
                    await sendTo24GolfApi('Booking_Create', url, payload, responseForBooking, accessToken, processedBookings, paymentAmounts, paymentStatus);
                    pendingCustomerRequests.delete(customerId);
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

      if (url.includes('/owner/booking') && status === 200 && method === 'POST') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Booking_Create') {
          let responseData;
          try {
            responseData = await response.json();
            console.log(`[DEBUG] Booking_Create Response Data:`, JSON.stringify(responseData, null, 2));
            if (responseData.book_id && responseData.idx) {
              bookingIds.set(responseData.book_id, responseData);
              bookIdToIdxMap.set(responseData.book_id, responseData.idx.toString());
              console.log(`[INFO] Mapped book_id ${responseData.book_id} to book_idx ${responseData.idx}`);

              bookingDataMap.set(responseData.book_id, {
                type: 'Booking_Create',
                payload: requestData.payload,
                response: responseData,
                timestamp: new Date()
              });
              console.log(`[INFO] Stored Booking_Create data for book_id ${responseData.book_id}`);

              const bookId = responseData.book_id;
              if (paymentAmounts.has(bookId) && paymentStatus.has(bookId)) {
                await sendTo24GolfApi(
                  'Booking_Create',
                  url,
                  requestData.payload,
                  responseData,
                  accessToken,
                  processedBookings,
                  paymentAmounts,
                  paymentStatus
                );
                bookingDataMap.delete(bookId);
                console.log(`[INFO] Processed Booking_Create for book_id ${bookId} immediately`);
              }
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
      }

      if (url.includes('/booking/confirm_state') && status === 200 && method === 'PATCH') {
        const requestData = requestMap.get(url);
        if (requestData && requestData.type === 'Booking_Confirm') {
          try {
            const text = await response.text();
            console.log(`[DEBUG] Raw response from /booking/confirm_state: ${text}`);
            if (!text) {
              console.log(`[WARN] Empty response from /booking/confirm_state`);
            } else {
              const responseData = JSON.parse(text);
              console.log(`[DEBUG] Booking_Confirm Response Data:`, JSON.stringify(responseData, null, 2));
            }
          } catch (e) {
            console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          }
          requestMap.delete(url);
        }
      }
    });

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