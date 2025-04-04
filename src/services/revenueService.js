// services/revenueService.js
const { parseMultipartFormData } = require('../utils/parser');
const { extractRevenueId, findBookIdByRevenueIdOrBookIdx, handleRevenueResponse } = require('../response-helpers');

class RevenueService {
  constructor(maps, accessToken) {
    this.maps = maps;
    this.accessToken = accessToken;
  }

  async handleRevenueUpdate(response, request) {
    const revenueId = extractRevenueId(response.url());
    if (!revenueId) return;

    const payload = parseMultipartFormData(request.postData());
    if (!payload?.book_idx || !payload?.amount) return;

    const revenueData = {
      revenueId,
      bookIdx: payload.book_idx,
      amount: parseInt(payload.amount, 10),
      finished: payload.finished === 'true',
      timestamp: Date.now()
    };

    const bookId = findBookIdByRevenueIdOrBookIdx(revenueId, payload.book_idx, this.maps);
    if (bookId) {
      this.maps.paymentAmounts.set(bookId, revenueData.amount);
      this.maps.paymentStatus.set(bookId, revenueData.finished);
    } else {
      this.maps.requestMap.set(`revenueUpdate_${revenueId}`, revenueData);
    }
  }

  async handleRevenueCreation(response, request) {
    await handleRevenueResponse(response, request, this.maps);
  }
}

module.exports = RevenueService;