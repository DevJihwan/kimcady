// services/bookingService.js
const { sendTo24GolfApi } = require('../utils/api');
const { parseMultipartFormData } = require('../utils/parser');
const { handleBookingListingResponse, handleBookingCreateResponse } = require('../response-helpers');

class BookingService {
  constructor(maps, accessToken, bookingDataCache) {
    this.maps = maps;
    this.accessToken = accessToken;
    this.bookingDataCache = bookingDataCache;
    this.processedAppBookings = new Set();
  }

  async handleBookingConfirmation(request) {
    const payload = parseMultipartFormData(request.postData());
    if (!payload || payload.state !== 'success') return;

    const bookingData = this._prepareBookingData(payload);
    await this._createBooking(bookingData);
    this.processedAppBookings.add(payload.book_id);
  }

  async handleBookingList(response) {
    const responseJson = await response.json();
    this.bookingDataCache.data = responseJson;
    this.bookingDataCache.timestamp = Date.now();

    await this._handleCancelingBookings(responseJson);
    await handleBookingListingResponse(response, this.maps);
  }

  async handleBookingCreation(response, request) {
    await handleBookingCreateResponse(response.url(), response, this.maps.requestMap, 
      this.accessToken, this.maps);
  }

  async _handleCancelingBookings(data) {
    const cancelingBookings = data.results?.filter(b => 
      b.state === 'canceling' && 
      !this.maps.processedBookings.has(b.book_id) && 
      !this.processedAppBookings.has(b.book_id)
    ) || [];

    for (const booking of cancelingBookings) {
      await this._cancelBooking(booking.book_id);
    }
  }

  _prepareBookingData(payload) {
    const bookingInfo = JSON.parse(payload.bookingInfo || '{}');
    return {
      externalId: payload.book_id,
      name: bookingInfo.name || payload.name || 'Unknown',
      phone: bookingInfo.phone || payload.phone || '010-0000-0000',
      partySize: parseInt(bookingInfo.person || payload.person || 1, 10),
      startDate: bookingInfo.start_datetime,
      endDate: bookingInfo.end_datetime,
      roomId: payload.room || bookingInfo.room || 'unknown',
      hole: bookingInfo.hole || '9',
      paymented: false,
      paymentAmount: parseInt(bookingInfo.amount || 0, 10),
      crawlingSite: 'KimCaddie',
      immediate: false
    };
  }

  async _createBooking(data) {
    const token = this.accessToken || await getAccessToken();
    await sendTo24GolfApi('Booking_Create', '', {}, data, token, 
      this.maps.processedBookings, this.maps.paymentAmounts, this.maps.paymentStatus);
  }

  async _cancelBooking(bookId) {
    const token = this.accessToken || await getAccessToken();
    await sendTo24GolfApi('Booking_Cancel', '', { 
      canceled_by: 'App User', 
      externalId: bookId 
    }, null, token, this.maps.processedBookings, 
    this.maps.paymentAmounts, this.maps.paymentStatus);
    this.processedAppBookings.add(bookId);
  }
}

module.exports = BookingService;