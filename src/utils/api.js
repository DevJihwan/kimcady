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

const sendTo24GolfApi = async (type, url, payload, apiData, accessToken, processedBookings = new Set(), paymentAmounts = new Map(), paymentStatus = new Map()) => {
    if (!accessToken) {
      console.error(`[API Error] Cannot send ${type}: Missing access token`);
      try {
        accessToken = await getAccessToken();
      } catch (e) {
        console.error(`[API Error] Failed to refresh token: ${e.message}`);
        return;
      }
    }
  
    const bookId = apiData?.externalId || payload?.externalId || 'unknown';
  
    if (type === 'Booking_Create' && processedBookings.has(bookId)) {
      console.log(`[INFO] Skipping duplicate Booking_Create for book_id: ${bookId}`);
      return;
    }
  
    // 결제 정보 설정
    let paymentAmount = apiData?.paymentAmount || paymentAmounts.get(bookId) || 0;
    let isPaymentCompleted = apiData?.paymented !== undefined ? apiData.paymented : paymentStatus.get(bookId) || false;
  
    console.log(`[DEBUG] Payment info for ${bookId} - Amount: ${paymentAmount}, Completed: ${isPaymentCompleted}`);
  
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${type} - URL: ${url} - Payload:`, JSON.stringify(payload, null, 2));
    console.log(`[DEBUG] Received apiData:`, JSON.stringify(apiData, null, 2));
  
    const headers = { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const storeId = getStoreId();
  
    let apiMethod, apiUrl, finalApiData;
    if (type === 'Booking_Create') {
      apiMethod = 'POST';
      apiUrl = `${API_BASE_URL}/stores/${storeId}/reservation/crawl`;
      finalApiData = extractAllowedFields(apiData);
    } else if (type === 'Booking_Update') {
      apiMethod = 'PATCH';
      apiUrl = `${API_BASE_URL}/stores/${storeId}/reservation/crawl`;
      // request.js에서 전달된 apiData를 우선 사용
      finalApiData = {
        ...extractAllowedFields(apiData),
        paymented: isPaymentCompleted,
        paymentAmount: paymentAmount
      };
    } else if (type === 'Booking_Cancel') {
      apiMethod = 'DELETE';
      apiUrl = `${API_BASE_URL}/stores/${storeId}/reservation/crawl`;
      finalApiData = { 
        externalId: bookId, 
        crawlingSite: 'KimCaddie', 
        reason: payload.canceled_by || 'Canceled by Manager' 
      };
    } else {
      console.log(`[WARN] Unknown type: ${type}, skipping API call`);
      return;
    }
  
    console.log(`[DEBUG] Final ${type} API data:`, JSON.stringify(finalApiData, null, 2));
  
    try {
      console.log(`[API Request] Sending ${type} to ${apiUrl}`);
      let apiResponse;
  
      if (apiMethod === 'DELETE') {
        apiResponse = await axios.delete(apiUrl, { 
          headers, 
          data: finalApiData,
          timeout: 10000
        });
      } else {
        apiResponse = await axios({ 
          method: apiMethod, 
          url: apiUrl, 
          headers, 
          data: finalApiData,
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
  
      if (error.response && error.response.status === 401) {
        console.log('[API] Token might be expired, attempting to refresh...');
        try {
          const newToken = await getAccessToken();
          return sendTo24GolfApi(type, url, payload, apiData, newToken, processedBookings, paymentAmounts, paymentStatus);
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
