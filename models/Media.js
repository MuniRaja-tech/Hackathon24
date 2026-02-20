const mongoose = require('mongoose');

const mediaSchema = new mongoose.Schema({
  type: String,  // 'txt' or 'mp4'
  name: String,
  size: Number,
  content: String,  // For text files
  base64: String,   // For video files
  ts: Number
}, { timestamps: true });

module.exports = mongoose.model('Media', mediaSchema);
