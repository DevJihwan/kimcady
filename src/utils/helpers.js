/**
 * 유틸리티 함수 모음
 */

/**
 * 예약 ID 형식에 맞는 랜덤 ID 생성
 * 실제 예약 ID 형식: 16자리 영숫자 대문자 (예: 0EC6C1CAB9B0408)
 * @returns {string} 형식에 맞는 ID
 */
const generateRandomBookId = () => {
  // 예약 ID 규칙: 16자리 영숫자 대문자
  const chars = 'ABCDEF0123456789';
  let result = '';
  
  // 16자리 ID 생성
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return result;
};

module.exports = {
  generateRandomBookId
};
