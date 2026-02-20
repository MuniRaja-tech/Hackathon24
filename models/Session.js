const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  username: String,
  focus: String,
  startTime: Number,
  lastSeen: Number,
  points: Number,
  badges: [String],
  aiUsed: Boolean
}, { timestamps: true });

module.exports = mongoose.model('Session', sessionSchema);
