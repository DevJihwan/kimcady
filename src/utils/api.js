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
    
    // immediate_booked가 true이면 결제 완료로 처리하던 부분 제거
    // 수정: 결제 완료 여부는 이미 paymentStatus에 설정된 값만 사용
    // if (response.immediate === true || response.immediate_booked === true) {
    //   isPaymentCompleted = true;
    //   paymentStatus.set(bookId, true);
    // }
    
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
    
    // 앱 예약인 경우와 웹 예약인 경우 처리 분리
    if (response && (response.bookType === 'U' || response.immediate === true)) {
      // 앱 예약 처리
      const currentDateTime = new Date().toISOString().replace('Z', '+09:00');
      
      // startDate가 undefined거나 "undefined"인 경우 현재 시간 사용
      let startDateTime = currentDateTime;
      if (response.startDate && response.startDate !== "undefined") {
        startDateTime = response.startDate;
      }
      
      apiData = {
        externalId: bookId,
        name: response.name || 'Unknown',
        phone: response.phone || '010-0000-0000',
        partySize: parseInt(response.partySize || 1, 10),
        startDate: startDateTime,
        endDate: response.endDate && response.endDate !== "undefined" ? 
                response.endDate : calculateEndTime(startDateTime),
        roomId: response.roomId || 'unknown',
        paymented: isPaymentCompleted,
        paymentAmount,
        crawlingSite: 'KimCaddie'
      };
      console.log(`[INFO] Creating API data for app booking`);
    } else {
      // 웹 예약 처리 (기존 방식)
      apiData = {
        externalId: bookId,
        name: response.name || payload?.name || 'Unknown',
        phone: response.phone || payload?.phone || '010-0000-0000',
        partySize: parseInt(response.person || payload?.person || 1, 10),
        startDate: response.start_datetime || `${payload?.book_date}T${payload?.book_time || '00:00:00'}+09:00`,
        endDate: response.end_datetime || calculateEndTime(response.start_datetime || `${payload?.book_date}T${payload?.book_time || '00:00:00'}+09:00`),
        roomId: (response.room || payload?.room || payload?.room_id || 'unknown').toString(),
        paymented: isPaymentCompleted,
        paymentAmount,
        crawlingSite: 'KimCaddie'
      };
    }
  } else if (type === 'Booking_Update') {
    apiMethod = 'PATCH';
    apiUrl = `${API_BASE_URL}/stores/${storeId}/reservation/crawl`;
    apiData = {
      externalId: bookId,
      name: payload.name || 'Unknown',
      phone: payload.phone || '010-0000-0000',
      partySize: parseInt(payload.person || 1, 10),
      startDate: payload.start_datetime || new Date().toISOString().replace('Z', '+09:00'),
      endDate: payload.end_datetime || calculateEndTime(payload.start_datetime),
      roomId: payload.room_id || payload.room || 'unknown',
      paymented: isPaymentCompleted,
      paymentAmount,
      crawlingSite: 'KimCaddie'
    };
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
    return new Date().toISOString().replace('Z', '+09:00');
  }
  
  try {
    const date = new Date(startTime);
    date.setHours(date.getHours() + 1);
    return date.toISOString().replace('Z', '+09:00');
  } catch (e) {
    console.error(`[ERROR] Failed to calculate end time from: ${startTime}`);
    return new Date().toISOString().replace('Z', '+09:00');
  }
};

module.exports = { getAccessToken, sendTo24GolfApi, getStoreInfo };