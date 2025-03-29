const { parseMultipartFormData } = require('../utils/parser');
const { sendTo24GolfApi } = require('../utils/api');

const setupRequestHandler = (page, accessToken, maps) => {
  const { requestMap, processedBookings, paymentAmounts, paymentStatus, bookIdToIdxMap } = maps;

  page.on('request', async (request) => {
    const url = request.url();
    const method = request.method();
    const postData = request.postData();
    const headers = request.headers();

    console.log(`[DEBUG] Request captured - URL: ${url}, Method: ${method}`);

    if (!url.startsWith('https://api.kimcaddie.com/api/')) return;

    const payload = parsePayload(headers, postData);

    // 등록 (Booking_Create)
    if (url.includes('/owner/booking') && method === 'POST') {
      console.log(`[INFO] Booking_Create detected - URL: ${url}`);
      requestMap.set(url, { url, method, payload, type: 'Booking_Create' });
    }

    // 변경 (Booking_Update) 및 취소 (Booking_Cancel)
    if (url.includes('/booking/change_info') && method === 'PATCH') {
      const bookingId = url.split('/').pop().split('?')[0];
      payload.externalId = bookingId;
      console.log(`[DEBUG] Booking change detected - URL: ${url}, Payload:`, JSON.stringify(payload, null, 2));

      if (!payload.state || payload.state !== 'canceled') {
        await handleBookingUpdate(page, url, payload, accessToken, processedBookings, paymentAmounts, paymentStatus);
      } else {
        console.log(`[INFO] Booking_Cancel detected for book_id: ${bookingId}`);
        await sendTo24GolfApi('Booking_Cancel', url, payload, null, accessToken, processedBookings, paymentAmounts, paymentStatus);
        console.log(`[INFO] Processed Booking_Cancel for book_id: ${bookingId}`);
      }
    }

    // PATCH /owner/revenue/
    if (url.match(/\/owner\/revenue\/\d+\/$/) && method === 'PATCH') {
      const revenueId = parseInt(url.split('/').slice(-2)[0], 10);
      console.log(`[INFO] Detected PATCH /owner/revenue/${revenueId}/`);
      requestMap.set(url, { url, method, payload, revenueId });
    }

    requestMap.set(url, { url, method, payload });
  });
};

const parsePayload = (headers, postData) => {
  const contentType = headers['content-type'] || '';
  let payload = {};
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
  return payload;
};

const handleBookingUpdate = async (page, url, payload, accessToken, processedBookings, paymentAmounts, paymentStatus) => {
  const bookingId = payload.externalId;
  let paymentAmountFromDom = 0;
  let paymentStatusFromDom = false;

  console.log(`[INFO] Processing Booking_Update for book_id: ${bookingId}`);

  try {
    await page.waitForSelector('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', { timeout: 5000 });
    const paymentAmountText = await page.$eval('.sc-pktCe.dSKYub .sc-pAyMl.fkDqVf', el => el.textContent.trim());
    paymentAmountFromDom = parseInt(paymentAmountText.replace(/[^0-9]/g, ''), 10);
    console.log(`[INFO] Extracted payment amount from DOM: ${paymentAmountFromDom}`);

    await new Promise(resolve => setTimeout(resolve, 3000));
    paymentAmountFromDom = paymentAmounts.get(bookingId) || paymentAmountFromDom;
    paymentStatusFromDom = paymentStatus.get(bookingId) || false;

    console.log(`[INFO] Payment status from API for book_id ${bookingId}: ${paymentStatusFromDom}`);
    console.log(`[INFO] Payment amount from API for book_id ${bookingId}: ${paymentAmountFromDom}`);
  } catch (e) {
    console.error(`[ERROR] Failed to extract payment info: ${e.message}`);
    paymentAmountFromDom = paymentAmounts.get(bookingId) || 0;
    paymentStatusFromDom = paymentStatus.get(bookingId) || false;
  }

  paymentAmounts.set(bookingId, paymentAmountFromDom);
  paymentStatus.set(bookingId, paymentStatusFromDom);
  console.log(`[DEBUG] Updated paymentStatus for ${bookingId}: ${paymentStatus.get(bookingId)}`);

  await sendTo24GolfApi('Booking_Update', url, payload, null, accessToken, processedBookings, paymentAmounts, paymentStatus);
  console.log(`[INFO] Processed Booking_Update for book_id ${bookingId}`);
};

module.exports = { setupRequestHandler };