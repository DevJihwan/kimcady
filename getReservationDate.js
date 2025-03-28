const puppeteer = require('puppeteer-core');
const fs = require('fs');

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

// 로그와 JSON 파일 저장을 위한 함수
const logAndSaveData = (type, url, payload, response = null) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${type} - URL: ${url} - Payload: ${JSON.stringify(payload)} - Response: ${response ? JSON.stringify(response) : 'N/A'}\n`;
  
  console.log(logMessage);
  const dataToSave = { url, payload };
  if (response) dataToSave.response = response;
  fs.writeFileSync(`${type}_${timestamp.replace(/:/g, '-')}.json`, JSON.stringify(dataToSave, null, 2));
};

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/path/to/chrome', // Chrome 경로 지정
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.goto('https://owner.kimcaddie.com/', { waitUntil: 'networkidle2' });

  // 요청과 응답을 저장할 임시 객체
  const requestMap = new Map();

  // API 요청 감지
  page.on('request', async (request) => {
    const url = request.url();
    const method = request.method();
    const postData = request.postData();
    const headers = request.headers();

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

      // 등록 요청
      if (url.includes('/owner/booking/') && method === 'POST') {
        requestMap.set(url, { method, payload, type: 'Booking_Create' });
        console.log(`[DEBUG] Request Captured - Method: ${method}, URL: ${url}, Payload: ${JSON.stringify(payload)}`);
      }
      // 변경 요청
      else if (url.includes('/booking/change_info') && method === 'PATCH' && (!payload.state || payload.state !== 'canceled')) {
        logAndSaveData('Booking_Update', url, payload);
      }
      // 취소 요청
      else if (url.includes('/booking/change_info') && method === 'PATCH' && payload.state === 'canceled') {
        logAndSaveData('Booking_Cancel', url, payload);
      }
    }
  });

  // API 응답 감지 (등록에 대해서만)
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    const request = response.request();
    const method = request.method();

    if (url === 'https://api.kimcaddie.com/api/owner/booking/' && status === 200 && method === 'POST') {
      const requestData = requestMap.get(url);
      if (requestData && requestData.type === 'Booking_Create') {
        let responseData;
        try {
          responseData = await response.json();
          console.log(`[DEBUG] Response Parsed - URL: ${url}, Data: ${JSON.stringify(responseData)}`);
        } catch (e) {
          console.log(`[DEBUG] Response Parse Failed - URL: ${url}, Error: ${e.message}`);
          responseData = null;
        }

        logAndSaveData('Booking_Create', url, requestData.payload, responseData);
        requestMap.delete(url);
      }
    }
  });

  console.log('브라우저가 열렸습니다. 로그인 및 예약 관리를 진행해주세요.');
})();