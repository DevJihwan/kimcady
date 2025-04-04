// services/customerService.js
const { sendTo24GolfApi } = require('../utils/api');

class CustomerService {
  constructor(maps, accessToken, processedCustomerRequests) {
    this.maps = maps;
    this.accessToken = accessToken;
    this.processedCustomerRequests = processedCustomerRequests;
    this.customerUpdates = new Map();
    this.recentCustomerIds = new Set();
  }

  async handleCustomerResponse(response) {
    const customerData = await response.json();
    const customerId = customerData?.id;
    if (!customerId) return;

    this._storeCustomerUpdate(customerData);
    if (this.recentCustomerIds.has(customerId) || this.processedCustomerRequests.has(customerId)) return;

    this.recentCustomerIds.add(customerId);
    this.processedCustomerRequests.add(customerId);

    setTimeout(() => this._processPendingCustomer(customerId), 10000);
  }

  _storeCustomerUpdate(data) {
    const latestUpdate = data.customerinfo_set?.[0]?.upd_date;
    if (!latestUpdate) return;

    const updateTime = new Date(latestUpdate).getTime();
    if (Date.now() - updateTime < 30000) {
      this.customerUpdates.set(data.id, {
        id: data.id,
        name: data.name || '',
        phone: data.phone || '',
        updateTime,
        timestamp: Date.now()
      });
    }
  }

  async _processPendingCustomer(customerId) {
    try {
      // Logic to process customer bookings would go here
      // Could be extracted to a separate method if needed
    } finally {
      this.recentCustomerIds.delete(customerId);
      setTimeout(() => this.processedCustomerRequests.delete(customerId), 60000);
    }
  }
}

module.exports = CustomerService;