const parseMultipartFormData = (data) => {
    const result = {};
    const boundary = data.match(/------WebKitFormBoundary[a-zA-Z0-9]+/)[0];
    const parts = data.split(boundary).slice(1, -1);
  
    parts.forEach(part => {
      const match = part.match(/name=\"([^\"]+)\"[\r\n]+([\s\S]+?)(?=\r\n|$)/);
      if (match) {
        const [, key, value] = match;
        result[key] = value.trim();
      }
    });
    console.log('[DEBUG] Parsed multipart/form-data:', JSON.stringify(result, null, 2));
    return result;
  };
  
  module.exports = { parseMultipartFormData };