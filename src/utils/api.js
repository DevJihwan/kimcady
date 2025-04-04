const axios = require('axios');
const { getStoreId, API_BASE_URL } = require('../config/env');

const getAccessToken = async () => {
  const storeId = getStoreId();
  const url = `${API_BASE_URL}/auth/token/stores/${storeId}/role/singleCrawler`;
  console.log(`[Token] Attempting to fetch access token from: ${url}`);

  try {
    const response = await axios.get(url, { 
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000 // 10 seconds timeout
    });
    
    if (!response.data) {
      throw new Error('Empty token response received');
    }
    
    const accessToken = response.data;
    console.log('[Token] Successfully obtained access token:', accessToken);
    return accessToken;
  } catch (error) {
    console.error('[Token Error] Failed to obtain access token:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    throw error;
  }
};

// 매장 정보 조회 함수
const getStoreInfo = async (storeId) => {
  try {
    console.log(`[Store] Fetching store information for ID: ${storeId}`);
    const url = `${API_BASE_URL}/stores/${storeId}`;
    
    const response = await axios.get(url, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
    
    if (!response.data) {
      throw new Error('Empty store data response received');
    }
    
    console.log('[Store] Successfully retrieved store information:', JSON.stringify(response.data, null, 2));
    return {
      success: true,
      data: response.data,
      name: response.data.name || '알 수 없는 매장',
      branch: response.data.branch || ''
    };
  } catch (error) {
    console.error(`[Store Error] Failed to retrieve store information for ID ${storeId}:`, error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
      
      // 404 오류인 경우 매장이 존재하지 않음
      if (error.response.status === 404) {
        return {
          success: false,
          error: '존재하지 않는 매장 ID입니다.',
          code: 'NOT_FOUND'
        };
      }
    }
    
    return {
      success: false,
      error: `매장 정보 조회에 실패했습니다: ${error.message}`,
      code: 'API_ERROR'
    };
  }
};

// 24golf API에서 허용하는 필드만 추출하는 함수
const extractAllowedFields = (data) => {
  // 엄격하게 허용된 필드만 포함
  const allowedFields = [
    'externalId',
    'name',
    'phone',
    'partySize',
    'startDate',
    'endDate',
    'roomId',
    'paymented',
    'paymentAmount',
    'crawlingSite'
  ];
  
  const result = {};
  for (const field of allowedFields) {
    if (data[field] !== undefined) {
      result[field] = data[field];
    }
  }
  
  return result;
};

// 한국 시간(KST)을 UTC로 변환하는 함수
const convertKSTtoUTC = (kstDateTimeString) => {
  if (!kstDateTimeString) return null;
  
  try {
    // KST 시간에서 UTC로 변환
    // '+09:00' 부분을 제거하고 ISO 8601 포맷으로 파싱
    let dateString = kstDateTimeString;
    if (dateString.includes('+09:00')) {
      // "+09:00"을 제거하고 해당 시간으로부터 9시간을 뺌
      dateString = dateString.replace('+09:00', '');
      const date = new Date(dateString);
      date.setHours(date.getHours() - 9);
      return date.toISOString(); // 이미 'Z'가 포함된 UTC 형식
    } else if (!dateString.includes('Z')) {
      // 'Z'도 '+09:00'도 없으면 로컬 시간으로 가정하고 UTC로 변환
      const date = new Date(dateString);
      return date.toISOString();
    }
    // 이미 UTC('Z' 포함)라면 그대로 반환
    return kstDateTimeString;
  } catch (e) {
    console.error(`[ERROR] Failed to convert KST to UTC: ${kstDateTimeString}`, e);
    return kstDateTimeString; // 변환 실패 시 원래 값 반환
  }
};

// 시간 문자열에서 시간대 정보 추출
const getTimezoneFromString = (dateTimeString) => {
  if (dateTimeString.includes('+09:00')) {
    return '+09:00';
  } else if (dateTimeString.includes('Z')) {
    return 'Z';
  }
  return '';
};

const sendTo24GolfApi = async (type, url, payload, response, accessToken, processedBookings = new Set(), paymentAmounts = new Map(), paymentStatus = new Map()) => {
  if (!accessToken) {
    console.error(`[API Error] Cannot send ${type}: Missing access token`);
    try {
      accessToken = await getAccessToken();
    } catch (e) {
      console.error(`[API Error] Failed to refresh token: ${e.message}`);
      return;
    }
  }

  const bookId = response?.book_id || response?.externalId || payload?.externalId || 'unknown';
  
  // 취소 요청인 경우 중복 체크하지 않음
  if (type === 'Booking_Create' && processedBookings.has(bookId)) {
    console.log(`[INFO] Skipping duplicate Booking_Create for book_id: ${bookId}`);
    return;
  }

  // 결제 정보 로깅 및 확인
  // 항상 저장된 맵에서 결제 정보를 가져옴
  let paymentAmount = paymentAmounts.get(bookId) || 0;
  let isPaymentCompleted = paymentStatus.get(bookId) || false;
  
  // 중요: 이미 apiData에 paymentAmount 값이 있는지 확인 (점주 예약)
  if (response && typeof response === 'object') {
    // response가 apiData일 가능성이 있음
    if (response.paymentAmount !== undefined) {
      const amount = parseInt(response.paymentAmount, 10);
      if (amount > 0) {
        paymentAmount = amount;
        console.log(`[INFO] Using payment amount ${paymentAmount} from apiData for book_id: ${bookId}`);
      }
    }
  }
  
  // payload에서 금액 추출 (가장 우선순위 높음)
  if (payload && typeof payload === 'object') {
    if (payload.amount && payload.amount !== 'undefined') {
      const amount = parseInt(payload.amount, 10);
      if (amount > 0) {
        paymentAmount = amount;
        console.log(`[INFO] Found amount ${paymentAmount} in request payload for book_id: ${bookId}`);
        paymentAmounts.set(bookId, paymentAmount);
      }
    }
  }
  
  // 앱 예약인 경우 response에서 결제 정보 추가 확인
  if (response && type === 'Booking_Create') {
    // response.paymentAmount가 있다면 그 값을 사용
    if (response.paymentAmount !== undefined && parseInt(response.paymentAmount, 10) > 0) {
      paymentAmount = parseInt(response.paymentAmount, 10);
      console.log(`[INFO] Using payment amount ${paymentAmount} from response object for book_id: ${bookId}`);
      paymentAmounts.set(bookId, paymentAmount);
    }
    
    // response.amount가 있다면 그 값을 사용
    else if (response.amount !== undefined && parseInt(response.amount, 10) > 0) {
      paymentAmount = parseInt(response.amount, 10);
      console.log(`[INFO] Using amount ${paymentAmount} from response object for book_id: ${bookId}`);
      paymentAmounts.set(bookId, paymentAmount);
    }
    
    // 이미 response.paymented 값이 있으면 그 값을 사용
    if (response.paymented !== undefined) {
      isPaymentCompleted = response.paymented;
      paymentStatus.set(bookId, isPaymentCompleted);
      console.log(`[INFO] Using payment status ${isPaymentCompleted} from response.paymented for book_id: ${bookId}`);
    }
  }
  
  console.log(`[DEBUG] Payment info from maps for ${bookId} - Amount: ${paymentAmount}, Completed: ${isPaymentCompleted}`);

  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${type} - URL: ${url} - Payload:`, JSON.stringify(payload, null, 2));
  console.log(`[DEBUG] API Data Prep - bookId: ${bookId}, paymentAmount: ${paymentAmount}, isPaymentCompleted: ${isPaymentCompleted}`);

  const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const storeId = getStoreId();

  let apiMethod, apiUrl, apiData;
  if (type === 'Booking_Create') {
    apiMethod = 'POST';
    apiUrl = `${API_BASE_URL}/stores/${storeId}/reservation/crawl`;
    
    // 완전한 API 데이터가 response에 있는 경우 (예약 확정)
    if (response && response.startDate && response.roomId) {
      console.log(`[INFO] Using complete API data from response object`);
      
      // UTC 시간으로 변환
      const startDateUTC = convertKSTtoUTC(response.startDate);
      const endDateUTC = response.endDate ? convertKSTtoUTC(response.endDate) : calculateEndTime(startDateUTC);
      
      console.log(`[DEBUG] Time conversion: ${response.startDate} -> ${startDateUTC}`);
      
      // 데이터를 복사해서 기본 API 데이터 생성
      const tempData = { 
        externalId: bookId,
        name: response.name || 'Unknown',
        phone: response.phone || '010-0000-0000',
        partySize: parseInt(response.partySize || 1, 10),
        startDate: startDateUTC,
        endDate: endDateUTC,
        roomId: response.roomId,
        paymented: isPaymentCompleted,
        paymentAmount: paymentAmount,
        crawlingSite: 'KimCaddie'
      };
      
      // 필수 필드만 포함된 객체 생성
      apiData = extractAllowedFields(tempData);
    }
    // 앱 예약인 경우
    else if (response && (response.bookType === 'U' || response.immediate === true)) {
      // 앱 예약 처리
      const currentDateTime = new Date().toISOString(); // 현재 시간 UTC로
      
      // startDate가 undefined거나 "undefined"인 경우 현재 시간 사용
      let startDateTime = currentDateTime;
      if (response.startDate && response.startDate !== "undefined") {
        startDateTime = convertKSTtoUTC(response.startDate);
      }
      
      const tempData = {
        externalId: bookId,
        name: response.name || 'Unknown',
        phone: response.phone || '010-0000-0000',
        partySize: parseInt(response.partySize || 1, 10),
        startDate: startDateTime,
        endDate: response.endDate && response.endDate !== "undefined" ? 
                convertKSTtoUTC(response.endDate) : calculateEndTime(startDateTime),
        roomId: response.roomId || 'unknown',
        paymented: isPaymentCompleted,
        paymentAmount,
        crawlingSite: 'KimCaddie'
      };
      
      console.log(`[INFO] Creating API data for app booking`);
      apiData = extractAllowedFields(tempData);
    } else {
      // 웹 예약 처리 (기존 방식)
      let startDateTime = null;
      if (response.start_datetime) {
        startDateTime = convertKSTtoUTC(response.start_datetime);
      } else if (payload?.book_date && payload?.book_time) {
        startDateTime = convertKSTtoUTC(`${payload.book_date}T${payload.book_time || '00:00:00'}+09:00`);
      } else {
        startDateTime = new Date().toISOString();
      }
      
      const tempData = {
        externalId: bookId,
        name: response.name || payload?.name || 'Unknown',
        phone: response.phone || payload?.phone || '010-0000-0000',
        partySize: parseInt(response.person || payload?.person || 1, 10),
        startDate: startDateTime,
        endDate: response.end_datetime ? 
                 convertKSTtoUTC(response.end_datetime) : 
                 calculateEndTime(startDateTime),
        roomId: (response.room || payload?.room || payload?.room_id || 'unknown').toString(),
        paymented: isPaymentCompleted,
        paymentAmount,
        crawlingSite: 'KimCaddie'
      };
      
      apiData = extractAllowedFields(tempData);
    }
  } else if (type === 'Booking_Update') {
    apiMethod = 'PATCH';
    apiUrl = `${API_BASE_URL}/stores/${storeId}/reservation/crawl`;
    
    let startDateTime = null;
    if (payload.start_datetime) {
      startDateTime = convertKSTtoUTC(payload.start_datetime);
    } else {
      startDateTime = new Date().toISOString();
    }
    
    const tempData = {
      externalId: bookId,
      name: payload.name || 'Unknown',
      phone: payload.phone || '010-0000-0000',
      partySize: parseInt(payload.person || 1, 10),
      startDate: startDateTime,
      endDate: payload.end_datetime ? 
               convertKSTtoUTC(payload.end_datetime) : 
               calculateEndTime(startDateTime),
      roomId: payload.room_id || payload.room || 'unknown',
      paymented: isPaymentCompleted,
      paymentAmount,
      crawlingSite: 'KimCaddie'
    };
    
    apiData = extractAllowedFields(tempData);
  } else if (type === 'Booking_Cancel') {
    apiMethod = 'DELETE';
    apiUrl = `${API_BASE_URL}/stores/${storeId}/reservation/crawl`;
    apiData = { 
      externalId: bookId, 
      crawlingSite: 'KimCaddie', 
      reason: payload.canceled_by || 'Canceled by Manager' 
    };
  } else {
    console.log(`[WARN] Unknown type: ${type}, skipping API call`);
    return;
  }

  // 최종 결제 정보 업데이트 (paymentAmounts, paymentStatus의 최신 값만 사용)
  if ((type === 'Booking_Create' || type === 'Booking_Update') && apiData) {
    const currentAmount = paymentAmounts.get(bookId);
    const currentStatus = paymentStatus.get(bookId);
    
    // 맵에 저장된 값이 있으면 사용, 없으면 이미 설정된 값 사용
    if (currentAmount !== undefined && currentAmount > 0) {
      apiData.paymentAmount = currentAmount;
    }
    
    if (currentStatus !== undefined) {
      apiData.paymented = currentStatus;
    }
    
    console.log(`[DEBUG] Final payment values for ${bookId}: Amount=${apiData.paymentAmount}, Completed=${apiData.paymented}`);
  }

  console.log(`[DEBUG] ${type} API data:`, JSON.stringify(apiData, null, 2));

  try {
    console.log(`[API Request] Sending ${type} to ${apiUrl}`);
    let apiResponse;
    
    if (apiMethod === 'DELETE') {
      apiResponse = await axios.delete(apiUrl, { 
        headers, 
        data: apiData,
        timeout: 10000
      });
    } else {
      apiResponse = await axios({ 
        method: apiMethod, 
        url: apiUrl, 
        headers, 
        data: apiData,
        timeout: 10000
      });
    }
    
    console.log(`[API] Successfully sent ${type}: ${apiResponse.status}`);
    console.log(`[API] Response data:`, JSON.stringify(apiResponse.data, null, 2));
    
    if (type === 'Booking_Create') {
      processedBookings.add(bookId);
    }
    
    return apiResponse.data;
  } catch (error) {
    console.error(`[API Error] Failed to send ${type}: ${error.message}`);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
    
    // Token might be expired, try to refresh once
    if (error.response && error.response.status === 401) {
      console.log('[API] Token might be expired, attempting to refresh...');
      try {
        const newToken = await getAccessToken();
        // Retry the request with the new token
        return sendTo24GolfApi(type, url, payload, response, newToken, processedBookings, paymentAmounts, paymentStatus);
      } catch (tokenError) {
        console.error(`[API Error] Failed to refresh token: ${tokenError.message}`);
      }
    }
  }
};

// Helper function to calculate end time (1 hour after start time)
const calculateEndTime = (startTime) => {
  if (!startTime || startTime.includes('undefined')) {
    console.log(`[WARN] Invalid start time for calculation: ${startTime}`);
    return new Date().toISOString(); // UTC 반환
  }
  
  try {
    const date = new Date(startTime);
    date.setHours(date.getHours() + 1);
    return date.toISOString(); // UTC 형식으로 반환 ('Z' 포함)
  } catch (e) {
    console.error(`[ERROR] Failed to calculate end time from: ${startTime}`);
    return new Date().toISOString(); // UTC 반환
  }
};

module.exports = { getAccessToken, sendTo24GolfApi, getStoreInfo, convertKSTtoUTC };
