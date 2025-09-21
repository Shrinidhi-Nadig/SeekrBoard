const admin = require('firebase-admin');
require('dotenv').config();



// For development/testing, you can use the project ID directly
// For production, use environment variables for security
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID || "seekr-board-4b3c7",
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID || "",
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') || "",
  client_email: process.env.FIREBASE_CLIENT_EMAIL || "",
  client_id: process.env.FIREBASE_CLIENT_ID || "",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${process.env.FIREBASE_CLIENT_EMAIL || ""}`
};

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "seekr-board-4b3c7.firebasestorage.app"
  });
}

// Get Firestore database instance
const db = admin.firestore();

// Get Storage bucket instance
const bucket = admin.storage().bucket();

// Authentication middleware
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Access token required. Please provide a valid Bearer token.'
      });
    }

    const token = authHeader.split('Bearer ')[1];
    
    // Verify the ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    
    // Attach user information to request object
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      email_verified: decodedToken.email_verified
    };
    
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    
    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        success: false,
        message: 'Token has expired. Please login again.'
      });
    }
    
    if (error.code === 'auth/invalid-id-token') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please provide a valid authentication token.'
      });
    }
    
    return res.status(401).json({
      success: false,
      message: 'Authentication failed. Please provide a valid token.'
    });
  }
};

// Helper function to get server timestamp
const getServerTimestamp = () => {
  return admin.firestore.FieldValue.serverTimestamp();
};

// Helper function to create a new document reference
const createDocRef = (collection) => {
  return db.collection(collection).doc();
};

// Helper function to get a document reference
const getDocRef = (collection, docId) => {
  return db.collection(collection).doc(docId);
};

module.exports = {
  admin,
  db,
  bucket,
  authenticateUser,
  getServerTimestamp,
  createDocRef,
  getDocRef
};
