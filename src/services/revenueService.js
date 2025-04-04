// services/revenueService.js
const { parseMultipartFormData } = require('../utils/parser');
const { extractRevenueId, findBookIdByRevenueIdOrBookIdx } = require('../handlers/response-helpers');
const { sendTo24GolfApi, getAccessToken } = require('../utils/api');

class RevenueService {
  constructor(maps, accessToken) {
    this.maps = maps;
    this.accessToken = accessToken;
  }

  async handleRevenueUpdate(response, request) {
    const revenueId = extractRevenueId(response.url());
    if (!revenueId) return;

    console.log(`[DEBUG] Processing revenue update for revenue ID: ${revenueId}`);
    const payload = parseMultipartFormData(request.postData());
    if (!payload?.book_idx || !payload?.amount) return;

    const revenueData = {
      revenueId,
      bookIdx: payload.book_idx,
      amount: parseInt(payload.amount, 10) || 0,
      finished: payload.finished === 'true',
      timestamp: Date.now()
    };

    // 이미 book_id를 알고 있는 경우 즉시 결제 정보 업데이트
    const bookId = findBookIdByRevenueIdOrBookIdx(revenueId, payload.book_idx, this.maps);
    if (bookId) {
      console.log(`[INFO] Found book_id ${bookId} for revenue ID ${revenueId} (or book_idx ${payload.book_idx})`);
      this.maps.paymentAmounts.set(bookId, revenueData.amount);
      this.maps.paymentStatus.set(bookId, revenueData.finished);
      console.log(`[INFO] Updated payment for book_id ${bookId}: amount=${revenueData.amount}, finished=${revenueData.finished}`);
      
      // 결제 정보 업데이트 데이터 저장 (보류 중인 처리를 위해)
      const revenueKey = `revenueUpdate_${revenueId}`;
      this.maps.requestMap.set(revenueKey, {
        bookId,
        bookIdx: payload.book_idx,
        revenueId,
        amount: revenueData.amount,
        finished: revenueData.finished,
        timestamp: Date.now()
      });
    } else {
      // 중요: 현재 생성 중인 예약이 있다면 결제 정보 업데이트
      const pendingBookings = this.findPendingBookings();
      if (pendingBookings.length > 0) {
        console.log(`[INFO] Found ${pendingBookings.length} pending bookings, updating with payment info`);
        for (const pendingKey of pendingBookings) {
          const bookingData = this.maps.requestMap.get(pendingKey);
          if (bookingData) {
            bookingData.paymentAmount = revenueData.amount;
            bookingData.paymentFinished = revenueData.finished;
            bookingData.paymentTimestamp = Date.now();
            
            console.log(`[INFO] Updated pending booking ${pendingKey} with payment amount ${revenueData.amount}`);
            this.maps.requestMap.set(pendingKey, bookingData);
          }
        }
      }
      
      // Store this data temporarily to use after we get booking data
      console.log(`[DEBUG] Storing revenue update data for revenue ID ${revenueId}, bookIdx ${payload.book_idx}: amount=${revenueData.amount}, finished=${revenueData.finished}`);
      
      // 나중에 결제 정보를 찾을 수 있도록 두 가지 키로 저장
      this.maps.requestMap.set(`revenueUpdate_${revenueId}`, revenueData);
      this.maps.requestMap.set(`paymentUpdate_${payload.book_idx}`, {
        revenueId,
        bookIdx: payload.book_idx,
        amount: revenueData.amount, 
        finished: revenueData.finished,
        processed: false,
        timestamp: Date.now()
      });
    }
  }

  async handleRevenueCreation(response, request) {
    try {
      const payload = parseMultipartFormData(request.postData());
      if (!payload?.book_idx || !payload?.amount) return;
      
      const bookIdx = payload.book_idx;
      const amount = parseInt(payload.amount, 10) || 0;
      const finished = payload.finished === 'true';
      
      console.log(`[INFO] Revenue creation detected: book_idx=${bookIdx}, amount=${amount}, finished=${finished}`);
      
      // 먼저 이미 매핑된 book_id가 있는지 확인
      let bookId = null;
      for (const [id, idx] of this.maps.bookIdToIdxMap.entries()) {
        if (idx === bookIdx) {
          bookId = id;
          break;
        }
      }
      
      if (bookId) {
        // 이미 존재하는 예약에 결제 정보 업데이트
        this.maps.paymentAmounts.set(bookId, amount);
        this.maps.paymentStatus.set(bookId, finished);
        console.log(`[INFO] Updated payment for existing book_id ${bookId}: amount=${amount}, finished=${finished}`);
      } else {
        // 아직 예약이 생성되지 않았거나 매핑되지 않은 경우, 임시 저장
        console.log(`[INFO] No matching book_id found for book_idx ${bookIdx}, storing payment info for later`);
        
        // 보류 중인 예약 생성이 있는지 확인
        const pendingBookings = this.findPendingBookings();
        if (pendingBookings.length > 0) {
          console.log(`[INFO] Found ${pendingBookings.length} pending bookings, updating with payment info`);
          for (const pendingKey of pendingBookings) {
            const bookingData = this.maps.requestMap.get(pendingKey);
            if (bookingData) {
              bookingData.paymentAmount = amount;
              bookingData.paymentFinished = finished;
              bookingData.bookIdx = bookIdx;  // 중요: book_idx 연결
              bookingData.paymentTimestamp = Date.now();
              
              console.log(`[INFO] Updated pending booking ${pendingKey} with payment amount ${amount}`);
              this.maps.requestMap.set(pendingKey, bookingData);
            }
          }
        }
        
        // 결제 정보 저장
        this.maps.requestMap.set(`paymentUpdate_${bookIdx}`, {
          bookIdx,
          amount,
          finished,
          processed: false,
          timestamp: Date.now()
        });
      }
    } catch (e) {
      console.error(`[ERROR] Failed to process revenue creation: ${e.message}`);
    }
  }
  
  // 보류 중인 예약 찾기
  findPendingBookings() {
    const pendingBookings = [];
    const now = Date.now();
    
    for (const [key, data] of this.maps.requestMap.entries()) {
      if (key.startsWith('bookingCreate_') && 
          data.tempBookId && 
          (now - data.timestamp < 10000)) { // 10초 이내 생성된 예약
        pendingBookings.push(key);
      }
    }
    
    return pendingBookings;
  }
}

module.exports = RevenueService;
