const express = require('express');
const multer = require('multer');
const { 
  db, 
  bucket, 
  authenticateUser, 
  getServerTimestamp, 
  createDocRef, 
  getDocRef 
} = require('./firebase');

const router = express.Router();

// Configure multer for memory storage (for Firebase Storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    // Check if file is an image
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Helper function to upload image to Firebase Storage
const uploadImageToStorage = async (file, folder = 'items') => {
  try {
    const fileName = `${folder}/${Date.now()}_${Math.round(Math.random() * 1E9)}_${file.originalname}`;
    const fileUpload = bucket.file(fileName);
    
    const stream = fileUpload.createWriteStream({
      metadata: {
        contentType: file.mimetype,
      },
    });

    return new Promise((resolve, reject) => {
      stream.on('error', (error) => {
        console.error('Upload error:', error);
        reject(error);
      });

      stream.on('finish', async () => {
        try {
          // Make the file public
          await fileUpload.makePublic();
          const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
          resolve(publicUrl);
        } catch (error) {
          reject(error);
        }
      });

      stream.end(file.buffer);
    });
  } catch (error) {
    throw new Error(`Failed to upload image: ${error.message}`);
  }
};

// Helper function to generate matches between lost and found items
const generateMatches = async (newItemId, newItemData) => {
  try {
    const { category, title, description, location, status } = newItemData;
    
    // Find potential matches based on category and similar text
    let query = db.collection('items')
      .where('category', '==', category)
      .where('status', '==', status === 'Lost' ? 'Found' : 'Lost');

    const snapshot = await query.get();
    const matches = [];

    for (const doc of snapshot.docs) {
      const existingItem = doc.data();
      let confidenceScore = 0;

      // Basic matching logic (can be enhanced with ML)
      if (existingItem.title.toLowerCase().includes(title.toLowerCase()) ||
          title.toLowerCase().includes(existingItem.title.toLowerCase())) {
        confidenceScore += 40;
      }

      if (existingItem.description && description) {
        const descWords = description.toLowerCase().split(' ');
        const existingDescWords = existingItem.description.toLowerCase().split(' ');
        const commonWords = descWords.filter(word => existingDescWords.includes(word));
        confidenceScore += Math.min(commonWords.length * 5, 30);
      }

      if (existingItem.location && location) {
        if (existingItem.location.toLowerCase() === location.toLowerCase()) {
          confidenceScore += 20;
        } else if (existingItem.location.toLowerCase().includes(location.toLowerCase()) ||
                   location.toLowerCase().includes(existingItem.location.toLowerCase())) {
          confidenceScore += 10;
        }
      }

      // Only create match if confidence score is above threshold
      if (confidenceScore >= 30) {
        const matchData = {
          lost_item_id: status === 'Lost' ? newItemId : doc.id,
          found_item_id: status === 'Found' ? newItemId : doc.id,
          confidence_score: confidenceScore,
          status: 'Pending',
          created_at: getServerTimestamp()
        };

        const matchRef = createDocRef('matches');
        await matchRef.set(matchData);

        // Create notification for both users
        const notificationData = {
          user_id: existingItem.posted_by,
          message: `Potential match found for your ${status.toLowerCase()} item: "${title}"`,
          is_read: false,
          created_at: getServerTimestamp(),
          match_id: matchRef.id
        };

        const notificationRef = createDocRef('notifications');
        await notificationRef.set(notificationData);

        matches.push({
          match_id: matchRef.id,
          confidence_score: confidenceScore,
          matched_item: {
            id: doc.id,
            title: existingItem.title,
            description: existingItem.description
          }
        });
      }
    }

    return matches;
  } catch (error) {
    console.error('Error generating matches:', error);
    return [];
  }
};

// GET /api/items - Fetch all items with optional filtering
router.get('/items', async (req, res) => {
  try {
    let query = db.collection('items').orderBy('date', 'desc');

    // Apply filters
    if (req.query.status) {
      query = query.where('status', '==', req.query.status);
    }
    if (req.query.category) {
      query = query.where('category', '==', req.query.category);
    }

    const snapshot = await query.get();
    const items = [];

    snapshot.forEach(doc => {
      items.push({
        id: doc.id,
        ...doc.data(),
        date: doc.data().date?.toDate?.() || doc.data().date
      });
    });

    res.json({
      success: true,
      data: items,
      count: items.length
    });
  } catch (error) {
    console.error('Error fetching items:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch items',
      error: error.message
    });
  }
});

// POST /api/items - Create a new item
router.post('/items', authenticateUser, upload.single('image'), async (req, res) => {
  try {
    const { title, description, category, contact_info, location, status } = req.body;

    // Validation
    if (!title || !category || !status) {
      return res.status(400).json({
        success: false,
        message: 'Title, category, and status are required fields'
      });
    }

    if (!['Lost', 'Found'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status must be either "Lost" or "Found"'
      });
    }

    let image_url = '';
    
    // Handle image upload if provided
    if (req.file) {
      try {
        image_url = await uploadImageToStorage(req.file);
      } catch (uploadError) {
        return res.status(400).json({
          success: false,
          message: 'Failed to upload image',
          error: uploadError.message
        });
      }
    }

    // Create item document
    const itemData = {
      title: title.trim(),
      description: description?.trim() || '',
      category: category.trim(),
      contact_info: contact_info?.trim() || '',
      location: location?.trim() || '',
      image_url,
      posted_by: req.user.uid,
      status,
      date: getServerTimestamp()
    };

    const itemRef = createDocRef('items');
    await itemRef.set(itemData);

    // Generate potential matches
    const matches = await generateMatches(itemRef.id, itemData);

    res.status(201).json({
      success: true,
      message: 'Item created successfully',
      data: {
        id: itemRef.id,
        ...itemData,
        matches_generated: matches.length
      },
      matches
    });
  } catch (error) {
    console.error('Error creating item:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create item',
      error: error.message
    });
  }
});

// GET /api/users/:id - Get user profile by ID
router.get('/users/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    const userRef = getDocRef('users', id);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userData = userDoc.data();

    // Get user's items count
    const itemsSnapshot = await db.collection('items')
      .where('posted_by', '==', id)
      .get();

    res.json({
      success: true,
      data: {
        id: userDoc.id,
        ...userData,
        items_count: itemsSnapshot.size
      }
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message
    });
  }
});

// GET /api/notifications - Get notifications for authenticated user
router.get('/notifications', authenticateUser, async (req, res) => {
  try {
    const { is_read } = req.query;
    
    let query = db.collection('notifications')
      .where('user_id', '==', req.user.uid)
      .orderBy('created_at', 'desc');

    if (is_read !== undefined) {
      query = query.where('is_read', '==', is_read === 'true');
    }

    const snapshot = await query.get();
    const notifications = [];

    snapshot.forEach(doc => {
      notifications.push({
        id: doc.id,
        ...doc.data(),
        created_at: doc.data().created_at?.toDate?.() || doc.data().created_at
      });
    });

    res.json({
      success: true,
      data: notifications,
      count: notifications.length
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch notifications',
      error: error.message
    });
  }
});

// PUT /api/notifications/:id/read - Mark notification as read
router.put('/notifications/:id/read', authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;

    const notificationRef = getDocRef('notifications', id);
    const notificationDoc = await notificationRef.get();

    if (!notificationDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Notification not found'
      });
    }

    const notificationData = notificationDoc.data();
    
    if (notificationData.user_id !== req.user.uid) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized to update this notification'
      });
    }

    await notificationRef.update({
      is_read: true,
      read_at: getServerTimestamp()
    });

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    console.error('Error updating notification:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update notification',
      error: error.message
    });
  }
});

// GET /api/matches - Get matches for authenticated user's items
router.get('/matches', authenticateUser, async (req, res) => {
  try {
    // Get user's items
    const userItemsSnapshot = await db.collection('items')
      .where('posted_by', '==', req.user.uid)
      .get();

    const userItemIds = userItemsSnapshot.docs.map(doc => doc.id);

    if (userItemIds.length === 0) {
      return res.json({
        success: true,
        data: [],
        count: 0
      });
    }

    // Get matches for user's items
    const matchesSnapshot = await db.collection('matches')
      .where('lost_item_id', 'in', userItemIds)
      .get();

    const foundMatchesSnapshot = await db.collection('matches')
      .where('found_item_id', 'in', userItemIds)
      .get();

    const allMatches = [...matchesSnapshot.docs, ...foundMatchesSnapshot.docs];
    const matches = [];

    for (const matchDoc of allMatches) {
      const matchData = matchDoc.data();
      
      // Get the matched items details
      const [lostItemDoc, foundItemDoc] = await Promise.all([
        getDocRef('items', matchData.lost_item_id).get(),
        getDocRef('items', matchData.found_item_id).get()
      ]);

      if (lostItemDoc.exists && foundItemDoc.exists) {
        matches.push({
          id: matchDoc.id,
          ...matchData,
          lost_item: {
            id: lostItemDoc.id,
            title: lostItemDoc.data().title,
            description: lostItemDoc.data().description,
            image_url: lostItemDoc.data().image_url
          },
          found_item: {
            id: foundItemDoc.id,
            title: foundItemDoc.data().title,
            description: foundItemDoc.data().description,
            image_url: foundItemDoc.data().image_url
          },
          created_at: matchData.created_at?.toDate?.() || matchData.created_at
        });
      }
    }

    res.json({
      success: true,
      data: matches,
      count: matches.length
    });
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch matches',
      error: error.message
    });
  }
});

// PUT /api/matches/:id/status - Update match status
router.put('/matches/:id/status', authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Pending', 'Confirmed', 'Rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status must be Pending, Confirmed, or Rejected'
      });
    }

    const matchRef = getDocRef('matches', id);
    const matchDoc = await matchRef.get();

    if (!matchDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Match not found'
      });
    }

    const matchData = matchDoc.data();

    // Check if user owns either item in the match
    const [lostItemDoc, foundItemDoc] = await Promise.all([
      getDocRef('items', matchData.lost_item_id).get(),
      getDocRef('items', matchData.found_item_id).get()
    ]);

    const userOwnsItem = lostItemDoc.data()?.posted_by === req.user.uid || 
                        foundItemDoc.data()?.posted_by === req.user.uid;

    if (!userOwnsItem) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized to update this match'
      });
    }

    await matchRef.update({
      status,
      updated_at: getServerTimestamp()
    });

    // If confirmed, update item statuses
    if (status === 'Confirmed') {
      await Promise.all([
        getDocRef('items', matchData.lost_item_id).update({ status: 'Returned' }),
        getDocRef('items', matchData.found_item_id).update({ status: 'Returned' })
      ]);
    }

    res.json({
      success: true,
      message: 'Match status updated successfully'
    });
  } catch (error) {
    console.error('Error updating match status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update match status',
      error: error.message
    });
  }
});

module.exports = router;
