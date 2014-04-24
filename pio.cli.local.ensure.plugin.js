
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const DNODE = require("dnode");
const EVENTS = require("events");
const Q = require("q");
const UUID = require("uuid");


var API = function(settings) {
	var self = this;
	self._settings = settings;

	ASSERT.equal(typeof self._settings.hostname, "string");
	ASSERT.equal(typeof self._settings.dnodePort, "number");

    self._dnodeClient = null;
    self._dnodeRemote = null;
    self._dnodeTimeout = null;
    self._dnodeEvents = new EVENTS.EventEmitter();
    self._dnodeCanConnect = false;
}

API.prototype._testDnodeConnection = function() {
	var self = this;
    var deferred = Q.defer();
    var timeout = setTimeout(function() {
        console.error("Timeout! Could not connect to: dnode://" + self._settings.hostname + ":" + self._settings.dnodePort);
        self._dnodeCanConnect = false;
        return deferred.resolve(false);
    }, 5000);
    var req = {
        timeClient: Date.now()
    }
    self._call("ping", req).then(function(res) {
        try {
            ASSERT.equal(req.timeClient, res.timeClient);
            // TODO: Track time offset.
            clearTimeout(timeout);
            self._dnodeCanConnect = true;
            return deferred.resolve(true);
        } catch(err) {
            clearTimeout(timeout);
            self._dnodeCanConnect = false;
            return deferred.resolve(false);
        }
    }).fail(function(err) {
        clearTimeout(timeout);
        self._dnodeCanConnect = false;
        return deferred.resolve(false);
    });
    return deferred.promise;
}

API.prototype._ensure = function() {
	if (this._dnodeCanConnect) {
		return Q.fcall(function() {
			return {
	    		dnodeAvailable: true,
	    		status: "ready"
			};
		});
	}
    return this._testDnodeConnection().then(function(canConnect) {
    	if (canConnect) {
    		return {
	    		dnodeAvailable: true,
	    		status: "ready"
    		};
    	} else {
    		return {
	    		required: false,
	    		status: "waiting"
    		};
    	}
	});
}

API.prototype._reconnect = function() {
    this._shutdown(true);
    this._dnodeCanConnect = false;
    return this._ensure();
}

API.prototype._shutdown = function(graceful) {
	var self = this;
    if (graceful) {
        // TODO: Allow no more new requests (queue them) and
        //       continue with shutdown once all requests have finished.
    }
    if (self._dnodeTimeout) {
        clearTimeout(self._dnodeTimeout);
        self._dnodeTimeout = null;
    }
    self._dnodeRemote = null;
    if (self._dnodeClient) {
        self._dnodeClient.end();
        self._dnodeClient = null;
    }
}

API.prototype._call = function(method, args) {
	var self = this;
    if (!self._dnodeCanConnect && method !== "ping") {
        return Q.resolve(null);
    }
    // Close the connection one second after last response if no
    // more requests.
    function startTimeout() {
        if (self._dnodeTimeout) {
            clearTimeout(self._dnodeTimeout);
        }
        self._dnodeTimeout = setTimeout(function() {
            return self._shutdown();
        }, 1 * 1000);
    }
    function callRemote() {
        var deferred = Q.defer();
        var stderr = [];
        var stdout = [];
        var requestId = UUID.v4();
        var stderrListener = function(_requestId, data) {
            if (_requestId === requestId) {
                stderr.push(data);
            }
        }
        var stdoutListener = function(_requestId, data) {
            if (_requestId === requestId) {
                stdout.push(data);
            }
        }
        self._dnodeEvents.on("stderr", stderrListener);
        self._dnodeEvents.on("stdout", stdoutListener);
        args.$requestId = requestId;
        self._dnodeRemote[method](args, function (errStack, response) {
            self._dnodeEvents.removeListener("stderr", stderrListener);
            self._dnodeEvents.removeListener("stdout", stdoutListener);
            startTimeout();
            if (errStack) {
                var err = new Error("Got remote error: " + stderr.join(""));
                err.stack = errStack;
                return deferred.reject(err);
            }
            if (method === "_runCommands") {

                response = {
                    code: response,
                    stdout: stdout.join(""),
                    stderr: stderr.join(""),
                    objects: {}
                };

                // TODO: Parse output in `stdoutListener` using streaming capability: https://github.com/olado/doT/issues/114
                (function parse() {
                    try {
                        var re = /<wf\s+name\s*=\s*"([^"]+)"\s*>([\S\s]+?)<\s*\/wf\s*>/g;
                        var m = null;
                        while (m = re.exec(response.stdout)) {
                            response.objects[m[1]] = JSON.parse(m[2]);
                        }
                    } catch(err) {
                        return deferred.reject(err);
                    }
                })();
            }
            return deferred.resolve(response);
        });
        return deferred.promise;
    }
    if (self._dnodeRemote) {
        if (self._dnodeTimeout) {
            clearTimeout(self._dnodeTimeout);
            self._dnodeTimeout = null;
        }
        return callRemote();
    }
    var deferred = Q.defer();
    self._dnodeClient = DNODE({
        stdout: function(_requestId, data) {
            self._dnodeEvents.emit("stdout", _requestId, new Buffer(data, "base64"));
            process.stdout.write(new Buffer(data, "base64"));
        },
        stderr: function(_requestId, data) {
            self._dnodeEvents.emit("stderr", _requestId, new Buffer(data, "base64"));
            process.stderr.write(new Buffer(data, "base64"));
        }
    });
    self._dnodeClient.on("error", function (err) {
        //console.error("dnode error", err.stack);
        return deferred.reject(err);
    });
    // TODO: Handle these failures better?
    self._dnodeClient.on("fail", function (err) {
        console.error("dnode fail", err.stack);
    });
    self._dnodeClient.on("remote", function (remote) {
        self._dnodeRemote = remote;
        return callRemote().then(deferred.resolve).fail(deferred.reject);
    });
    self._dnodeClient.connect(self._settings.dnodePort, self._settings.hostname);
    return deferred.promise;
}


exports.ensure = function(pio, state) {

    var response = {
        status: "unknown"
    };

    return pio.API.Q.fcall(function() {

        ASSERT(
        	typeof state["pio.vm"].ip === "string" ||
        	typeof state["pio"].hostname === "string"
        , "'state[pio.vm].ip' or 'state[pio].hostname' must be set to a string!");

        ASSERT(typeof pio.getConfig("config")["pio.deploy"].dnodePort === "number", "'config[pio.deploy].dnodePort' must be set to a number!");

	    var api = new API({
	    	hostname: state["pio.vm"].ip || state["pio"].hostname,
	    	dnodePort: pio.getConfig("config")["pio.deploy"].dnodePort
	    });
	    pio.once("shutdown", function() {
			return api._shutdown();
	    });

	    return api._ensure().then(function(_response) {

            if (!state["pio.service"]) {
                var Res = function (properties) {
                    for (var name in properties) {
                        this[name] = properties[name];
                    }
                }
                Res.prototype = api;
                response = new Res(pio.API.DEEPMERGE(response, _response));
                return;
            }

            ASSERT(typeof state["pio.service"].originalPath === "string", "'config[pio.service].originalPath' must be set to a string!");
            ASSERT(typeof state["pio.service.deployment"].path === "string", "'config[pio.service.deployment].path' must be set to a string!");

            _response.fileinfoPath = PATH.join(state["pio.service"].originalPath, ".pio.cache", "pio.deploy.ensure.fileinfo.json");

            function hasChanged() {

                var syncFiletreeInfo = null;

                function loadCache() {
                    var deferred = Q.defer();
                    FS.exists(_response.fileinfoPath, function(exists) {
                        if (!exists) return deferred.resolve(null);
                        return FS.readJson(_response.fileinfoPath, function(err, json) {
                            if (err) return deferred.reject(err);
                            return deferred.resolve(json);
                        });
                    });
                    return deferred.promise;
                }
                return loadCache().then(function(_cache) {
                    api.getCachedFileInfo = function () {
                        return pio.API.Q.resolve(_cache);
                    }
                    return api._call("info", {
                        "servicePath": state["pio.service.deployment"].path
                    }).then(function(info) {
                        _response.remoteInfo = info;
                        return;
                    });
                });
            }

            return hasChanged().then(function() {
    	    	var Res = function (properties) {
    	    		for (var name in properties) {
    	    			this[name] = properties[name];
    	    		}
    	    	}
    	    	Res.prototype = api;
                Res.prototype._remoteInfo = _response.remoteInfo;
                delete _response.remoteInfo;
    	    	response = new Res(pio.API.DEEPMERGE(response, _response));
                response.isSynced = function(state) {
                    var remoteInfo = response._remoteInfo;
                    if (
                        !remoteInfo ||
                        !remoteInfo.config ||
                        !remoteInfo.config["pio.service"] ||
                        (
                            !remoteInfo.config["pio.service"].originalChecksum &&
                            !remoteInfo.config["pio.service"].finalChecksum
                        )
                    ) {
                        console.log("No remote originalChecksum nor finalChecksum!");
                        return false;
                    }
                    if (typeof state["pio.service"].finalChecksum !== "undefined") {
                        if (remoteInfo.config["pio.service"].finalChecksum === state["pio.service"].finalChecksum) {
                            return true;
                        }
                        console.log(("Final checksum has changed! (local " + state["pio.service"].finalChecksum + " != " + remoteInfo.config["pio.service"].finalChecksum + " remote)").cyan);
                        return false;
                    }
                    if (remoteInfo.config["pio.service"].originalChecksum === state["pio.service"].originalChecksum) {
                        return true;
                    }
                    console.log(("Original checksum has changed! (local " + state["pio.service"].originalChecksum + " != " + remoteInfo.config["pio.service"].originalChecksum + " remote)").cyan);
                    return false;

// TODO: If service is in read mode 0444, don't need to scan source, can just use cached checksum.
// TODO: Record remote state and attach comare helpers to pio.deploy state so we can test if need to publish.
//       This will allow setting of finalChecksum later without needing to commit to comare state now.

                }
    	    	return;
            });
		});

    }).then(function() {
        response.status = "ready";

        return pio.API.Q.resolve({
            "pio.deploy": response
        });
    });
}
