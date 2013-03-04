'use strict';

var RecentsDBManager = {
  _dbName: 'dialerRecents',
  _dbRecentsStore: 'dialerRecents',
  _dbGroupStore: 'dialerGroups',
  _dbVersion: 3,
  _lastGroupId: 0,
  prepolulated: false,
  init: function rdbm_init(callback) {
    try {
      var indexedDB = window.indexedDB || window.webkitIndexedDB ||
                        window.mozIndexedDB || window.msIndexedDB;
      if (!indexedDB) {
        console.log('Indexed DB is not available!!!');
        return;
      }
      var self = this;
      this.request = indexedDB.open(this._dbName, this._dbVersion);
      this.request.onsuccess = function(event) {
        self.db = event.target.result;
        if (!navigator.mozTelephony && !self.prepopulated) {
          self.prepopulateDB();
          self.prepopulated = true;
        }
        var store = self.db.transaction(self._dbGroupStore)
                        .objectStore(self._dbGroupStore);
        store.openCursor(null, 'prev').onsuccess = function(event) {
          var cursor = event.target.result;
          if (!cursor) {
            return;
          }
          self._lastGroupId = cursor.id || 0;

          if (callback) {
            callback();
          }
        }
      };
      this.request.onerror = function(event) {
        // TODO Do we have to implement any custom error handler?
        console.log('Database error: ' + event.target.errorCode);
      };

      this.request.onupgradeneeded = function(event) {
        var db = event.target.result;

        var currentVersion = event.oldVersion;
        while (currentVersion != event.newVersion) {
          switch (currentVersion) {
            case 0:
              self._createSchema(db);
              break;
            case 1:
              self._upgradeSchemaVersion2(db);
              break;
            case 2:
              self._upgradeSchemaVersion3(event.target.transaction);
              break;
            default:
              event.target.transaction.abort();
              break;
          }
          currentVersion++;
        }

      };
    } catch (ex) {
      console.log('Dialer recents IndexedDB exception:' + ex.message);
    }
  },
  close: function rbdm_close() {
    this.db.close();
  },
  // Create the initial database schema.
  _createSchema: function rdbm_createSchema(db) {
    // The object store hosting the recents call will contain entries like:
    // { date: <Date> (primary key),
    //   number: <String>,
    //   type: <String>,
    //   groupId: <Number> }
    var objStore = db.createObjectStore(this._dbRecentsStore,
                                        { keyPath: 'date' });
    objStore.createIndex('number', 'number');
  },
  // Upgrade schema to version 2.
  // Create an object store to host groups of calls.
  _upgradeSchemaVersion2: function upgradeSchemaVersion2(db) {
    // This object store can be used to quickly construct a group view of the
    // recent calls database. Each entry looks like this:
    //
    // { number: <String> (primary key),
    //   id: <Number>,
    //   date: <Date>,
    //   type: <String>,
    //   retryCount: <Number> }
    //
    var objectStore = db.createObjectStore(this._dbGroupStore,
                                           { keyPath: 'number' });
    objectStore.createIndex('date', 'date');
    objectStore.createIndex('id', 'id');
  },
  // Upgrade schema to version 3.
  // Populate quick groups view.
  _upgradeSchemaVersion3: function upgradeSchemaVersion3(transaction) {
    var groups = {};
    this._lastGroupId = 0;
    var recentsStore = transaction.objectStore(this._dbRecentsStore);
    var groupsStore = transaction.objectStore(this._dbGroupStore);

    recentsStore.openCursor().onsuccess = (function(event) {
      var cursor = event.target.result;
      if (!cursor) {
        for (var group in groups) {
          groupStore.put(groups[group]);
        }
        return;
      }

      var record = cursor.value;
      var number = record.number;

      if (number in groups) {
        var group = groups[number];
        if (record.type === group.type) {
          group.retryCount++;
        } else {
          group.type = record.type;
        }
        if (record.date > group.date) {
          group.date = record.date;
        }
      } else {
        this._lastGroupId++;
        groups[number] = {
          number: number,
          id: this._lastGroupId,
          date: record.date,
          retryCount: 1
        };
      }
      record.groupId = groups[number].id;
      recentsStore.put(record);
      cursor.continue();
    }).bind(this);
  },
  _checkDBReady: function rdbm_checkDBReady(callback) {
    /*var self = this;
    if (!this.db) {
      this.request.addEventListener('success', function rdbm_DBReady() {
        self.request.removeEventListener('success', rdbm_DBReady);
        self._checkDBReady.call(self, callback);
      });
      return;
    }*/
    if (callback && callback instanceof Function) {
      callback.call(this);
    }
  },
  add: function rdbm_add(recentCall, callback) {
    var self = this;
    this._checkDBReady.call(this, function() {
      var txn = this.db.transaction([self._dbRecentsStore,
                                     self._dbGroupStore], 'readwrite');
      var recentStore = txn.objectStore(self._dbRecentsStore);
      var groupStore = txn.objectStore(self._dbGroupStore);
      groupStore.get(recentCall.number).onsuccess = function(event) {
        var group = event.target.result;
        if (group) {
          if (group.date <= recentCall.date) {
            group.date = recentCall.date;
          }

          if (group.type === recentCall.type) {
            group.retryCount++;
          } else {
            group.type = recentCall.type;
            group.retryCount = 1;
          }
          event.target.source.put(group);
        } else {
          self._lastGroupId++;
          event.target.source.add({
            id: self._lastGroupId,
            number: recentCall.number,
            date: recentCall.date,
            type: recentCall.type,
            retryCount: 1
          });
        }
        recentCall.groupId = self._lastGroupId;
        recentStore.put(recentCall).onsuccess = function() {
          if (callback) {
            callback();
          }
        };
      };
    });
  },
  delete: function rdbm_delete(date, callback) {
    var self = this;
    this._checkDBReady(function() {
      var txn = self.db.transaction(self._dbRecentsStore, 'readwrite');
      var store = txn.objectStore(self._dbRecentsStore);
      var delRequest = store.delete(date);

      delRequest.onsuccess = function de_onsuccess() {
        if (callback && callback instanceof Function) {
          callback();
        }
      };

      delRequest.onerror = function de_onsuccess(e) {
        console.log('recents_db delete item failure: ',
            e.message, delRequest.errorCode);
      };
    });
  },
  deleteList: function rdbm_deleteList(list, callback) {
    if (list.length > 0) {
      var itemToDelete = list.pop();
      var self = this;
      this.delete(itemToDelete, function() {
        self.deleteList(list, callback);
      });
    } else {
      if (callback) {
        callback();
      }
    }
  },
  deleteAll: function rdbm_deleteAll(callback) {
    var self = this;
    this._checkDBReady(function() {
      var txn = self.db.transaction(self._dbRecentsStore, 'readwrite');
      var store = txn.objectStore(self._dbRecentsStore);

      var delAllRequest = store.clear();
      delAllRequest.onsuccess = function da_onsuccess() {
        if (callback && callback instanceof Function) {
          callback();
        }
      };

      delAllRequest.onerror = function da_onerror(e) {
        console.log('recents_db delete all failure: ',
          e.message, delAllRequest.errorCode);
      };
    });
  },
  _getList: function rdbm_getList(store, callback, getCursor, limit) {
    this._checkDBReady(function() {
      var objectStore = this.db.transaction(store).objectStore(store);
      var result = [];
      var cursor = objectStore.openCursor(null, 'prev');
      if (getCursor) {
        callback(cursor);
        return;
      }
      cursor.onsuccess = function(event) {
        var item = event.target.result;
        if (item && (typeof limit === 'undefined' || limit > 0)) {
          result.push(item.value);
          if (limit) {
            limit--;
          }
          item.continue();
        } else {
          callback(result);
        }
      };
      cursor.onerror = function(e) {
        console.log('_getList failure: ', e.message);
      };
    });
  },
  getRecentList: function rdbm_getRecentList(callback, getCursor, limit) {
    this._getList(this._dbRecentsStore, callback, getCursor, limit);
  },
  getGroupList: function rdbm_getGroupList(callback, getCursor, limit) {
    this._getList(this._dbGroupStore, callback, getCursor, limit);
  },
  getLast: function rdbm_getLast(callback) {
    var objectStore = this.db.transaction(RecentsDBManager._dbRecentsStore).
                        objectStore(RecentsDBManager._dbRecentsStore);
    var cursor = objectStore.openCursor(null, 'prev');
    cursor.onsuccess = function(event) {
      var item = event.target.result;
      if (item) {
        callback(item.value);
      }
    };

    cursor.onerror = function(e) {
      console.log('recents_db get failure: ', e.message);
    };
  },
  // Method for prepopulating the recents DB for the dev team.
  prepopulateDB: function rdbm_prepopulateDB(callback) {
    var recent;
    var numbers = [];
    for (var i = 0; i < 50; i++) {
      numbers.push(Math.round(Math.random()*10000000000).toString());
    }
    for (var i = 0; i < 50; i++) {
      recent = {
        date: (Date.now() - i * 86400000),
        type: 'incoming',
        number: Math.round(Math.random() * 10000000) % numbers.length
      };
      this.add(recent);
    }
    recent = {
      date: (Date.now() - 86400000),
      type: 'dialing',
      number: '321321321'
    };
    this.add(recent);
    if (callback) {
      callback();
    }
  },
};
