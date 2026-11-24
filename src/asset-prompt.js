// The prompt a card's picture is made from, written in Chinese and sent as it is: Qwen-Image reads Chinese.
// Text-to-image describes the whole picture; image-to-image (QwenB) is told what to keep and what to change.
// `look` is the card's own edit of the list's appearance line (the list itself stays as written).
const { pictureStyle, dropNoText } = require('./prompt-hygiene');

const NO_TEXT = '画面上没有字幕和文字。';

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();

// The style paragraph is cut down to what this picture needs (no notes to the writer, no rules for other kinds of
// pictures), and "no text" is said once at the end however many times the parts say it.
function buildPrompt({ mode, card = {}, ask, look }) {
  const description = clean(dropNoText(typeof look === 'string' ? look : card.description));
  const wish = clean(dropNoText(ask));
  const style = clean(pictureStyle(card.style, [card.name, card.code, description, wish].join(' ')));
  const lines = mode === 'i2i'
    ? [description ? `保持参考图里${clean(card.name) || '主体'}的外形不变：${description}` : '', wish, style]
    : [style, description, wish];
  lines.push(NO_TEXT);
  return lines.filter(Boolean).join('\n');
}

module.exports = { buildPrompt };
