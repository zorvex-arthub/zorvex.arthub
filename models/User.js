const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    minlength: [2, 'Name must be at least 2 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true,
    match: [/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false  // Never returned in queries by default
  },
  role: {
    type: String,
    enum: ['buyer', 'artist', 'admin'],
    default: 'buyer'
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  avatar: {
    type: String,  // URL or base64
    default: null
  },
  // For artists — reference to their profile
  artistProfile: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ArtistProfile',
    default: null
  }
}, {
  timestamps: true
});

// ── PASSWORD VALIDATION (before save) ──
// Must start with Capital letter AND contain at least one digit
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  // Validate password format
  const passwordRegex = /^[A-Z](?=.*\d).+$/;
  if (!passwordRegex.test(this.password)) {
    return next(new Error(
      'Password must start with a capital letter and contain at least one number (e.g., Zorvex1)'
    ));
  }

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── COMPARE PASSWORD ──
UserSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
