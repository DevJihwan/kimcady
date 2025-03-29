const parseMultipartFormData = (data) => {
  if (!data) {
    console.log('[DEBUG] No data to parse');
    return {};
  }

  const result = {};
  
  try {
    const boundaryMatch = data.match(/------WebKitFormBoundary[^\r\n]+/);
    if (!boundaryMatch) {
      console.log('[DEBUG] No boundary found in multipart data');
      return {};
    }
    
    const boundary = boundaryMatch[0];
    const parts = data.split(boundary).slice(1, -1);
  
    parts.forEach(part => {
      // Improved regex to better handle multiline content
      const match = part.match(/name="([^"]+)"(?:[\r\n]+|.)*?(?:[\r\n]{2})([\s\S]*?)(?=[\r\n]------WebKit|$)/);
      if (match) {
        const [, key, value] = match;
        result[key] = value.trim();
      }
    });
    console.log('[DEBUG] Parsed multipart/form-data:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[ERROR] Failed to parse multipart form data:', error.message);
  }
  
  return result;
};
  
module.exports = { parseMultipartFormData };