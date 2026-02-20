const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: String,
  points: { type: Number, default: 0 },
  badges: [String]
}, { timestamps: true });

module.exports = mongoose.model('Student', studentSchema);
