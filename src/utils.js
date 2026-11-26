const VIETNAM_TIME_ZONE = 'Asia/Ho_Chi_Minh';

// Bỏ dấu tiếng Việt và viết thường để so sánh không phân biệt hoa thường / dấu.
function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function truncate(value, maxLength) {
  const text = String(value);

  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

module.exports = {
  VIETNAM_TIME_ZONE,
  normalizeText,
  truncate,
};
