const { parseMultipartFormData } = require('../utils/parser');
const { sendTo24GolfApi, getAccessToken, convertKSTtoUTC } = require('../utils/api');
const { pendingCreateBookingIds } = require('./response-helpers');

const pendingBookingMap = new Map();
const processedApiCallMap = new Map();

const setupRequestHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;

  page.on('request', async (request) => {
    const url = request.url();
    const method = request.method();
    const postData = request.postData();
    const headers = request.headers();

    if (!url.startsWith('https://api.kimcaddie.com/api/')) return;

    const payload = parsePayload(headers, postData);
    if (!payload) {
      console.log(`[WARN] Failed to parse payload for URL: ${url}`);
      return;
    }

    // 앱 예약 상태 변경 처리 (confirm_state API)
    if (url.includes('/api/booking/confirm_state') && (method === 'PATCH' || method === 'PUT')) {
      console.log(`[INFO] App booking state change detected - URL: ${url}, Method: ${method}`);
      console.log(`[DEBUG] App booking state change payload:`, JSON.stringify(payload, null, 2));

      if (payload.book_id) {
        const bookId = payload.book_id;

        if (payload.state === 'canceled') {
          console.log(`[INFO] App Booking_Cancel detected for book_id: ${bookId}`);
          try {
            let currentToken = accessToken || await getAccessToken();
            let cancelReason = 'App User';
            if (payload.bookingInfo) {
              const bookingInfo = JSON.parse(payload.bookingInfo || '{}');
              cancelReason = bookingInfo.cancel_reason || cancelReason;
              if (bookingInfo.amount) {
                const amount = parseInt(bookingInfo.amount, 10) || 0;
                paymentAmounts.set(bookId, amount);
                console.log(`[INFO] Extracted payment amount ${amount} from bookingInfo for book_id: ${bookId}`);
              }
            }
            processedBookings.delete(bookId);
            const cancelPayload = { externalId: bookId, canceled_by: cancelReason };
            await sendTo24GolfApi('Booking_Cancel', url, cancelPayload, null, currentToken, processedBookings, paymentAmounts, paymentStatus);
            console.log(`[INFO] Successfully processed App Booking_Cancel for book_id: ${bookId}`);
          } catch (error) {
            console.error(`[ERROR] Failed to process App Booking_Cancel: ${error.message}`);
          }
        } else if (payload.state === 'confirmed') {
          console.log(`[INFO] App Booking_Create detected for book_id: ${bookId} - storing for later processing`);
          const tempKey = `app_booking_${bookId}`;
          pendingBookingMap.set(tempKey, {
            url,
            payload,
            timestamp: Date.now()
          });
          pendingCreateBookingIds.add(bookId);
        }
      }
      requestMap.set(url, { url, method, payload, type: 'App_Booking_State_Change' });
    }

    // 점주 예약 등록 (Booking_Create)
    else if (url.includes('/owner/booking') && method === 'POST') {
      console.log(`[INFO] Booking_Create detected - URL: ${url}, Method: ${method}`);
      console.log(`[DEBUG] Booking_Create payload:`, JSON.stringify(payload, null, 2));
      
      if (payload.book_type === 'M' || !payload.book_id) {
        const startDate = convertKSTtoUTC(payload.start_datetime);
        const endDate = convertKSTtoUTC(payload.end_datetime);
        
        console.log(`[DEBUG] Manager booking - converting time: ${payload.start_datetime} -> ${startDate}`);
        const tempKey = `booking_${Date.now()}`;
        
        pendingBookingMap.set(tempKey, {
          url,
          payload,
          startDate,
          endDate,
          timestamp: Date.now()
        });
        
        console.log(`[INFO] Waiting for booking response to get real book_id for ${tempKey}`);
      }
      
      bookingDataMap.set(url, { type: 'Booking_Create', payload, timestamp: Date.now() });
      requestMap.set(url, { url, method, payload, type: 'Booking_Create' });
    }

    // 변경 (Booking_Update) 및 취소 (Booking_Cancel)
    else if (url.includes('/booking/change_info') && method === 'PATCH') {
      let bookingId = extractBookingId(url);
      if (!bookingId) {
        console.log(`[ERROR] Failed to extract booking ID from URL: ${url}`);
        return;
      }

      payload.externalId = bookingId;
      console.log(`[DEBUG] Booking change detected - URL: ${url}, BookingId: ${bookingId}, Payload:`, JSON.stringify(payload, null, 2));

      if (pendingCreateBookingIds.has(bookingId)) {
        console.log(`[INFO] Skipping update for booking ${bookingId} as it's being created`);
        return;
      }

      if (payload.state && payload.state === 'canceled') {
        console.log(`[INFO] Booking_Cancel detected for book_id: ${bookingId}`);
        try {
          let currentToken = accessToken || await getAccessToken();
          await sendTo24GolfApi('Booking_Cancel', url, payload, null, currentToken, processedBookings, paymentAmounts, paymentStatus);
          console.log(`[INFO] Processed Booking_Cancel for book_id: ${bookingId}`);
        } catch (error) {
          console.error(`[ERROR] Failed to process Booking_Cancel: ${error.message}`);
        }
      } else {
        console.log(`[INFO] Booking_Update detected for book_id: ${bookingId} - storing for later processing`);
        bookingDataMap.set(`pendingUpdate_${bookingId}`, {
          type: 'Booking_Update_Pending',
          url,
          payload,
          timestamp: Date.now(),
          lastStartDate: payload.start_datetime,
          lastEndDate: payload.end_datetime,
          lastPerson: payload.person,
          lastHole: payload.hole
        });
      }

      requestMap.set(url, { url, method, payload, bookingId });
    }

    // PATCH /owner/revenue/ - 결제 정보 업데이트
    else if (url.match(/\/owner\/revenue\/\d+\/$/) && method === 'PATCH') {
      const revenueId = extractRevenueId(url);
      if (revenueId && payload && payload.amount !== undefined && payload.finished !== undefined) {
        const amount = parseInt(payload.amount, 10) || 0;
        const finished = payload.finished === 'true';
        const bookIdx = payload.book_idx;

        let bookId = null;
        for (const [key, value] of bookingDataMap.entries()) {
          if (value.payload?.idx === bookIdx || value.payload?.book_idx === bookIdx) {
            bookId = value.payload.book_id || value.payload.externalId;
            break;
          }
        }

        if (bookId) {
          paymentAmounts.set(bookId, amount);
          paymentStatus.set(bookId, finished);
          console.log(`[INFO] Directly mapped book_idx ${bookIdx} to book_id ${bookId}`);
        } else {
          requestMap.set(`paymentUpdate_${bookIdx}`, {
            revenueId,
            bookIdx,
            amount,
            finished,
            processed: false,
            timestamp: Date.now()
          });
        }
      }
    }
    
    else if (url.includes('/owner/booking/') && method === 'GET') {
      console.log(`[INFO] Detected GET /owner/booking/ - will process pending updates after response`);
    }

    requestMap.set(url, { url, method, payload });
  });
  
  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
  
    if (url.includes('/api/owner/booking/') && (status === 200 || status === 201)) {
      try {
        const responseData = await response.json();
        if (responseData && responseData.book_id) {
          const bookId = responseData.book_id;
          const bookIdx = responseData.idx?.toString();
  
          console.log(`[INFO] Received booking creation response with book_id: ${bookId}, idx: ${bookIdx}`);
  
          if (processedApiCallMap.has(bookId)) {
            console.log(`[INFO] Already processed API call for book_id: ${bookId}, skipping`);
            return;
          }
  
          pendingCreateBookingIds.add(bookId);
        }
      } catch (error) {
        console.error(`[ERROR] Failed to parse booking creation response: ${error.message}`);
      }
    }
  
    if (url.includes('/owner/booking/') && response.request().method() === 'GET') {
      try {
        const bookingData = await response.json();
        console.log(`[DEBUG] /owner/booking/ response received, count: ${bookingData.results?.length || 0}`);
  
        let currentToken = accessToken;
        if (!currentToken) {
          console.log(`[DEBUG] Access token not provided, fetching new one`);
          currentToken = await getAccessToken();
          console.log(`[DEBUG] Fetched access token: ${currentToken}`);
        }
  
        // Booking_Create 처리
        for (const booking of bookingData.results || []) {
          const bookId = booking.book_id;
          const bookIdx = booking.idx?.toString();
          const revenueDetail = booking.revenue_detail || {};
          const amount = parseInt(revenueDetail.amount || booking.amount || 0, 10);
          const finished = revenueDetail.finished === true || revenueDetail.finished === 'true';
  
          if (processedApiCallMap.has(bookId)) {
            console.log(`[INFO] Skipping already processed book_id: ${bookId}`);
            continue;
          }
  
          if (bookId && pendingCreateBookingIds.has(bookId)) {
            paymentAmounts.set(bookId, amount);
            paymentStatus.set(bookId, finished);
            console.log(`[INFO] Mapped revenue for book_id ${bookId}: amount=${amount}, finished=${finished}, idx=${bookIdx}`);
  
            let bookingInfo;
            let latestKey;
            for (const [key, value] of pendingBookingMap.entries()) {
              if (key.startsWith('app_booking_') && value.payload.book_id === bookId) {
                bookingInfo = value;
                latestKey = key;
                break;
              } else if (key.startsWith('booking_')) {
                bookingInfo = value;
                latestKey = key;
                break;
              }
            }
  
            if (bookingInfo) {
              console.log(`[INFO] Processing pending booking with real book_id: ${bookId}`);
  
              const apiData = {
                externalId: bookId,
                name: booking.name || bookingInfo.payload.name || 'Guest',
                phone: bookingInfo.payload.phone || '010-0000-0000',
                partySize: parseInt(booking.person || bookingInfo.payload.person || 1, 10),
                startDate: convertKSTtoUTC(booking.start_datetime || bookingInfo.payload.start_datetime),
                endDate: convertKSTtoUTC(booking.end_datetime || bookingInfo.payload.end_datetime),
                roomId: booking.room?.toString() || bookingInfo.payload.room_id || 'unknown',
                hole: booking.hole || bookingInfo.payload.hole || '18',
                paymented: finished,
                paymentAmount: amount,
                crawlingSite: 'KimCaddie',
                immediate: false
              };
  
              console.log(`[DEBUG] Booking_Create API data: ${JSON.stringify(apiData, null, 2)}`);
  
              try {
                await sendTo24GolfApi(
                  'Booking_Create',
                  bookingInfo.url,
                  bookingInfo.payload,
                  apiData,
                  currentToken,
                  processedBookings,
                  paymentAmounts,
                  paymentStatus
                );
  
                console.log(`[INFO] Successfully sent Booking_Create for book_id: ${bookId}, amount: ${amount}`);
                processedApiCallMap.set(bookId, { timestamp: Date.now(), processed: true });
                pendingCreateBookingIds.delete(bookId);
                pendingBookingMap.delete(latestKey);
              } catch (error) {
                console.error(`[ERROR] Failed to send Booking_Create for book_id ${bookId}: ${error.message}`);
                if (error.message.includes('E11000 duplicate key error')) {
                  processedApiCallMap.set(bookId, { timestamp: Date.now(), processed: true });
                  pendingCreateBookingIds.delete(bookId);
                  pendingBookingMap.delete(latestKey);
                  console.log(`[INFO] Marked book_id ${bookId} as processed due to duplicate error`);
                }
              }
            }
          }
        }
  
            // Booking_Update 처리
for (const [key, value] of bookingDataMap.entries()) {
    if (key.startsWith('pendingUpdate_')) {
      const bookId = value.payload.externalId;
      const updateData = bookingData.results.find(b => b.book_id === bookId);
  
      if (!updateData) {
        console.log(`[WARN] No booking data found for update of book_id: ${bookId}`);
        continue;
      }
  
      console.log(`[DEBUG] bookingDataMap value for ${bookId}: ${JSON.stringify(value, null, 2)}`);
      console.log(`[DEBUG] updateData for ${bookId}: ${JSON.stringify(updateData, null, 2)}`);
  
      const updateKey = `update_${bookId}`;
      const revenueDetail = updateData.revenue_detail || {};
      const pendingPayment = requestMap.get(`paymentUpdate_${updateData.idx}`);
      const amount = parseInt(pendingPayment?.amount || value.payload.amount || revenueDetail.amount || updateData.amount || 0, 10);
      const finished = pendingPayment?.finished || value.payload.finished === 'true' || revenueDetail.finished === true || revenueDetail.finished === 'true';
      
      // 시간 변환 디버깅 강화
      const rawStartDate = value.payload.start_datetime;
      const rawEndDate = value.payload.end_datetime;
      console.log(`[DEBUG] Raw start_datetime: ${rawStartDate}, end_datetime: ${rawEndDate}`);
      const startDate = convertKSTtoUTC(rawStartDate);
      const endDate = convertKSTtoUTC(rawEndDate);
      console.log(`[DEBUG] Converted startDate: ${startDate}, endDate: ${endDate}`);
  
      const person = parseInt(value.payload.person || updateData.person || 1, 10);
      const hole = value.payload.hole || updateData.hole || '18';
      const roomId = value.payload.room_id || updateData.room?.toString() || 'unknown';
  
      if (pendingPayment) {
        requestMap.delete(`paymentUpdate_${updateData.idx}`);
        console.log(`[INFO] Integrated payment update for book_id: ${bookId} into Booking_Update`);
      }
  
      const lastData = processedApiCallMap.get(updateKey) || {};
      const hasChanges =
        lastData.amount !== amount ||
        lastData.finished !== finished ||
        lastData.startDate !== startDate ||
        lastData.endDate !== endDate ||
        lastData.person !== person ||
        lastData.hole !== hole ||
        lastData.roomId !== roomId;
  
      if (!hasChanges && processedApiCallMap.has(updateKey)) {
        console.log(`[INFO] No changes detected for Booking_Update of book_id: ${bookId}, skipping`);
        bookingDataMap.delete(key);
        continue;
      }
  
      paymentAmounts.set(bookId, amount);
      paymentStatus.set(bookId, finished);
  
      const apiData = {
        externalId: bookId,
        name: updateData.name || value.payload.name || 'Guest',
        phone: updateData.phone || value.payload.phone || '010-0000-0000',
        partySize: person,
        startDate: startDate,
        endDate: endDate,
        roomId: roomId,
        hole: hole,
        paymented: finished,
        paymentAmount: amount,
        crawlingSite: 'KimCaddie',
        immediate: false
      };
  
      console.log(`[DEBUG] Booking_Update API data: ${JSON.stringify(apiData, null, 2)}`);
  
      try {
        await sendTo24GolfApi(
          'Booking_Update',
          value.url,
          value.payload,
          apiData,
          currentToken,
          processedBookings,
          paymentAmounts,
          paymentStatus
        );
  
        console.log(`[INFO] Successfully sent Booking_Update for book_id: ${bookId}`);
        processedApiCallMap.set(updateKey, {
          timestamp: Date.now(),
          processed: true,
          amount,
          finished,
          startDate,
          endDate,
          person,
          hole,
          roomId
        });
        bookingDataMap.delete(key);
      } catch (error) {
        console.error(`[ERROR] Failed to send Booking_Update for book_id ${bookId}: ${error.message}`);
      }
    }
  }
      } catch (error) {
        console.error(`[ERROR] Failed to parse /owner/booking/ response: ${error.message}`);
      }
    }
  });


  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    const keysToDelete = [];
    
    for (const [key, data] of requestMap.entries()) {
      if (data.timestamp && (now - data.timestamp > 3600000)) keysToDelete.push(key);
    }
    
    for (const key of keysToDelete) requestMap.delete(key);
    
    const pendingKeysToDelete = [];
    for (const [key, data] of pendingBookingMap.entries()) {
      if (data.timestamp && (now - data.timestamp > 3600000)) pendingKeysToDelete.push(key);
    }
    
    for (const key of pendingKeysToDelete) pendingBookingMap.delete(key);
    
    const processedKeysToDelete = [];
    for (const [key, value] of processedApiCallMap.entries()) {
      if ((now - value.timestamp) > 3600000) processedKeysToDelete.push(key);
    }
    
    for (const key of processedKeysToDelete) processedApiCallMap.delete(key);
    
    if (keysToDelete.length > 0 || pendingKeysToDelete.length > 0 || processedKeysToDelete.length > 0) {
      console.log(`[INFO] Cleaned up ${keysToDelete.length} request entries, ${pendingKeysToDelete.length} pending booking entries, and ${processedKeysToDelete.length} processed API calls`);
    }
  }, 60 * 60 * 1000);
  
  page.once('close', () => clearInterval(cleanupInterval));
};

const extractRevenueId = (url) => {
  try {
    const match = url.match(/\/owner\/revenue\/(\d+)\//);
    if (match && match[1]) return parseInt(match[1], 10);
  } catch (err) {
    console.error(`[ERROR] Failed to extract revenue ID from URL: ${url}`);
  }
  return null;
};

const parsePayload = (headers, postData) => {
  if (!postData) return {};
  const contentType = headers['content-type'] || '';
  let payload = {};
  
  try {
    if (contentType.includes('multipart/form-data')) {
      payload = parseMultipartFormData(postData);
    } else if (contentType.includes('application/json')) {
      payload = JSON.parse(postData);
    } else {
      payload = { raw: postData };
    }
  } catch (error) {
    console.error(`[ERROR] Failed to parse payload: ${error.message}`);
    return {};
  }
  
  return payload;
};

const extractBookingId = (url) => {
  try {
    return url.split('/').pop().split('?')[0];
  } catch (e) {
    console.error(`[ERROR] Failed to extract booking ID from URL: ${url}`);
    return null;
  }
};

module.exports = { setupRequestHandler };