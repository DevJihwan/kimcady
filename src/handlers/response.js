// responseHandler.js
const { sendTo24GolfApi, getAccessToken } = require('../utils/api');
const BookingService = require('./services/bookingService');
const CustomerService = require('./services/customerService');
const RevenueService = require('./services/revenueService');
const { parseMultipartFormData } = require('../utils/parser');

let processedCustomerRequests = new Set();
let bookingDataCache = { timestamp: 0, data: null };

const setupResponseHandler = (page, accessToken, maps) => {
  const bookingService = new BookingService(maps, accessToken, bookingDataCache);
  const customerService = new CustomerService(maps, accessToken, processedCustomerRequests);
  const revenueService = new RevenueService(maps, accessToken);

  page.on('response', async (response) => {
    const url = response.url();
    const status = response.status();
    const request = response.request();
    const method = request.method();

    if (!url.includes('api.kimcaddie.com/api/') || status >= 400) return;

    try {
      const handlers = {
        '/api/booking/confirm_state': () => 
          method === 'PATCH' && bookingService.handleBookingConfirmation(request),
        '/api/owner/customer/': () => 
          method === 'GET' && customerService.handleCustomerResponse(response),
        '/owner/booking/': () => 
          method === 'GET' && bookingService.handleBookingList(response),
        '/owner/revenue/': () => {
          if (method === 'PATCH') return revenueService.handleRevenueUpdate(response, request);
          if (method === 'POST') return revenueService.handleRevenueCreation(response, request);
        },
        '/owner/booking': () => 
          method === 'POST' && (status === 200 || status === 201) && 
          bookingService.handleBookingCreation(response, request)
      };

      const handlerKey = Object.keys(handlers).find(key => url.includes(key));
      if (handlerKey) await handlers[handlerKey]();

    } catch (error) {
      console.error(`[ERROR] Error handling response for ${url}: ${error.message}`);
    }
  });
};

module.exports = { setupResponseHandler };