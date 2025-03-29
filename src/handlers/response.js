const { sendTo24GolfApi } = require('../utils/api');
const { parseMultipartFormData } = require('../utils/parser');

const setupResponseHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap, revenueToBookingMap, bookingDataMap } = maps;

  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    const request = response.request();
    const method = request.method();

    console.log(`[DEBUG] Response captured - URL: ${url}, Status: ${status}`);

    // /owner/booking/ GET 응답 처리
    if (url.includes('/owner/booking/') && method === 'GET' && status === 200) {
      try {
        const responseBody = await response.json();
        console.log(`[DEBUG] /owner/booking/ response received, count: ${responseBody.count}`);

        responseBody.results.forEach((booking) => {
          const bookId = booking.book_id;
          const revenueId = booking.revenue;
          const amount = booking.revenue_detail.amount;
          const finished = booking.revenue_detail.finished;

          revenueToBookingMap.set(revenueId, bookId);
          paymentAmounts.set(bookId, amount);
          paymentStatus.set(bookId, finished);
          bookIdToIdxMap.set(bookId, booking.idx.toString()); // idx 매핑 추가

          console.log(`[INFO] Mapped revenue ${revenueId} to book_id ${bookId}, amount: ${amount}, finished: ${finished}, idx: ${booking.idx}`);
        });
      } catch (e) {
        console.error(`[ERROR] Failed to parse /owner/booking/ response: ${e.message}`);
      }
    }

    // /owner/revenue/ POST 응답 처리
    if (url.includes('/owner/revenue/') && method === 'POST' && status === 200) {
      try {
        const responseData = await response.json();
        const payload = parseMultipartFormData(request.postData());
        const bookIdx = payload.book_idx;
        const amount = parseInt(payload.amount, 10) || 0;
        const finished = responseData.finished || payload.finished === 'true';

        let bookId = Array.from(bookIdToIdxMap.entries()).find(([, idx]) => idx === bookIdx)?.[0];
        if (bookId) {
          paymentAmounts.set(bookId, amount);
          paymentStatus.set(bookId, finished);
          console.log(`[INFO] Updated payment for book_id ${bookId} (book_idx ${bookIdx}): amount=${amount}, finished=${finished}`);
        } else {
          console.log(`[WARN] No book_id found for book_idx ${bookIdx}`);
        }
      } catch (e) {
        console.error(`[ERROR] Failed to parse /owner/revenue/ response: ${e.message}`);
      }
    }

    // /owner/booking POST 응답 처리 (Booking_Create)
    if (url.includes('/owner/booking') && method === 'POST' && status === 200) {
      try {
        const responseData = await response.json();
        console.log(`[DEBUG] Booking_Create Response Data:`, JSON.stringify(responseData, null, 2));
        const requestData = requestMap.get(url);

        if (requestData && requestData.type === 'Booking_Create' && responseData.book_id) {
          const bookId = responseData.book_id;
          bookIdToIdxMap.set(bookId, responseData.idx.toString());
          bookingDataMap.set(bookId, { type: 'Booking_Create', payload: requestData.payload, response: responseData, timestamp: Date.now() });

          console.log(`[INFO] Booking_Create stored for book_id ${bookId}, idx: ${responseData.idx}`);

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
          console.log(`[INFO] Processed Booking_Create for book_id ${bookId}`);
          bookingDataMap.delete(bookId);
          requestMap.delete(url);
        }
      } catch (e) {
        console.error(`[ERROR] Failed to parse Booking_Create response: ${e.message}`);
      }
    }
  });
};

module.exports = { setupResponseHandler };