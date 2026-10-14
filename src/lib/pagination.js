function pagination(page = 1, limit = 20, max = 100) {
  const number = (value, fallback) => {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : fallback;
  };
  const pageNum = number(page, 1);
  const limitNum = Math.min(max, number(limit, 20));
  const offset = (pageNum - 1) * limitNum;
  return { pageNum, limitNum, offset: Number.isSafeInteger(offset) ? offset : 0 };
}
module.exports = { pagination };
