
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const Q = require("q");
const DIRSUM = require("dirsum");
const CRYPTO = require("crypto");
const EXEC = require("child_process").exec;
const COLORS = require("colors");
const JSON_DIFF_PATCH = require("jsondiffpatch");
const ESCAPE_REGEXP = require("escape-regexp");


COLORS.setTheme({
    error: "red"
});


exports.deploy = function(pio, state) {

    var response = {
        status: "unknown"
    };

    return pio.API.Q.fcall(function() {
        ASSERT.equal(typeof state["pio.vm"].ip, "string", "'state[pio.vm].ip' must be set to a string!");
        ASSERT.equal(typeof state["pio.vm"].user, "string", "'state[pio.vm].user' must be set to a string!");
        ASSERT.equal(typeof state["pio.vm"].prefixPath, "string", "'state[pio.vm].prefixPath' must be set to a string!");
        ASSERT.equal(typeof state["pio"].keyPath, "string", "'state[pio.vm].keyPath' must be set to a string!");
        ASSERT.equal(typeof state["pio.service"].path, "string", "'state[pio.service].path' must be set to a string!");
        ASSERT.equal(typeof state["pio.service"].id, "string", "'state[pio.service].id' must be set to a string!");
        ASSERT.equal(typeof state["pio.service"].descriptor, "object", "'state[pio.service].descriptor' must be set to an object!");
        ASSERT.equal(typeof pio._state["pio.deploy"].isSynced, "function", "'state[pio.deploy].isSynced' must be set to a function!");
        ASSERT.equal(typeof state["pio.service.deployment"].path, "string", "'state[pio.service.deployment].path' must be set to a string!");

        function attempt(count) {
            count += 1;

            function deploy() {
                function hasChanged() {
                    if (pio._state["pio.deploy"].isSynced(state)) {
                        return pio.API.Q.resolve(false);
                    }
                    return pio._state["pio.deploy"].getCachedFileInfo().then(function (previousSyncFiletreeInfo) {
                        if (!previousSyncFiletreeInfo) {
                            return true;
                        }
                        return pio._state["pio.service"].getFileInfo().then(function (syncFiletreeInfo) {
                            console.log(
                                JSON_DIFF_PATCH.formatters.console.format(
                                    JSON_DIFF_PATCH.create({
                                        // @source https://github.com/benjamine/jsondiffpatch/issues/21#issuecomment-23892647
                                        objectHash: function(obj) {
                                            var hash = [];
                                            for (var prop in obj) {
                                                if (obj.hasOwnProperty(prop)) {
                                                    hash.push(prop);
                                                }
                                            }
                                            return hash.sort().join('');
                                        }
                                    }).diff(previousSyncFiletreeInfo, syncFiletreeInfo)
                                )
                            );
                            return true;
                        });
                    });
                }

                return hasChanged().then(function(deploy) {

                    if (!deploy) {
                        if (state["pio.cli.local"].force) {
                            console.log(("Skip deploy service '" + state["pio.service"].id + "'. It has not changed. BUT CONTINUE due to 'state[pio.cli.local].force'").yellow);
                        } else {
                            console.log(("Skip deploy service '" + state["pio.service"].id + "'. It has not changed.").yellow);
                            response.status = "skipped";
                            return;
                        }
                    }

                    var serviceConfig = {
                        uuid: state["pio.service"].uuid,
                        config: pio.API.DEEPMERGE(pio.API.DEEPCOPY(pio._config.config), pio.API.DEEPCOPY(state)),
                        "config.plugin": state["pio.service.deployment"]["config.plugin"],
                        env: state["pio.service.deployment"].env,
                        upstream: {
                            packages: {
                                "all": PATH.join(state["pio.vm"].prefixPath, "services", "*")
                            }
                        }
                    };

                    // TODO: Make this more generic.
                    var sanitizedServiceConfig = JSON.stringify(serviceConfig, null, 4);
                    var variables = [
                        "AWS_USER_NAME",
                        "AWS_ACCESS_KEY",
                        "AWS_SECRET_KEY",
                        "DNSIMPLE_EMAIL",
                        "DNSIMPLE_TOKEN",
                        "PIO_EPOCH_ID",
                        "PIO_SEED_SALT",
                        "PIO_SEED_KEY",
                        "PIO_USER_ID",
                        "PIO_USER_SECRET"
                    ];
                    for (var name in process.env) {
                        variables.forEach(function(variable) {
                            if (name.indexOf(variable) >= 0) {
                                variables.push(name);
                            }
                        });
                    }
                    variables.forEach(function(name) {
                        if (!process.env[name]) return;
                        sanitizedServiceConfig = sanitizedServiceConfig.replace(new RegExp(ESCAPE_REGEXP(process.env[name]), "g"), process.env[name].substring(0, 3) + "***");
                    });

                    console.log(("Deploy service '" + state["pio.service"].id + "' with config: " + sanitizedServiceConfig).cyan);

                    return Q.denodeify(FS.outputFile)(PATH.join(state["pio.service"].path, ".pio.json"), JSON.stringify(serviceConfig, null, 4)).then(function() {

                        function uploadSource(targetPath, source) {
                            return pio._state["pio.deploy"]._call("_putFile", {
                                path: targetPath,
                                body: source.toString("base64")
                            }).then(function(response) {
                                if (response === true) return;
                                return pio.API.SSH.uploadFile({
                                    targetUser: state["pio.vm"].user,
                                    targetHostname: state["pio.vm"].ip,
                                    source: source,
                                    targetPath: targetPath,
                                    keyPath: state["pio"].keyPath
                                });
                            });
                        }

                        function runRemoteCommands(commands, workingDirectory) {
                            console.log(("Running remote commands '" + commands.join("; ") + "' in '" + workingDirectory + "'.").magenta);
                            function sshUpload() {
                                return pio.API.SSH.runRemoteCommands({
                                    targetUser: state["pio.vm"].user,
                                    targetHostname: state["pio.vm"].ip,
                                    commands: commands,
                                    workingDirectory: workingDirectory,
                                    keyPath: state["pio"].keyPath
                                });
                            }
                            // NOTE: If deploying the `pio.server` which handles
                            //       the `_runCommands` call we always use SSH to run the commands.
                            //       If we do not do that our commands will exit early as the
                            //       `pio.server` restarts.
                            if (state["pio.service"].id === "pio.server") {
                                return sshUpload();
                            }
                            return pio._state["pio.deploy"]._call("_runCommands", {
                                commands: commands,
                                cwd: workingDirectory
                            }).then(function(response) {
                                if (response !== null) {
                                    if (response.code === 0) return response;
                                    throw new Error("Remote commands exited with code: " + response.code);
                                }
                                return sshUpload();
                            });
                        }

                        function ensurePrerequisites(repeat) {
                            function ensureGlobalPrerequisites() {
                                if (repeat) {
                                    return Q.reject("Could not provision prerequisites on system!");
                                }
                                return runRemoteCommands([
                                    // Make sure our user can write to the default install directory.
                                    "sudo chown -f " + state["pio.vm"].user + ":" + state["pio.vm"].user + " " + state["pio.vm"].prefixPath,
                                    // Make sure some default directories exist
                                    'if [ ! -d "' + state["pio.vm"].prefixPath + '/bin" ]; then mkdir ' + state["pio.vm"].prefixPath + '/bin; fi',
                                    'if [ ! -d "' + state["pio.vm"].prefixPath + '/cache" ]; then mkdir ' + state["pio.vm"].prefixPath + '/cache; fi',
                                    'if [ ! -d "' + state["pio.vm"].prefixPath + '/data" ]; then mkdir ' + state["pio.vm"].prefixPath + '/data; fi',
                                    'if [ ! -d "' + state["pio.vm"].prefixPath + '/tmp" ]; then mkdir ' + state["pio.vm"].prefixPath + '/tmp; fi',
                                    'if [ ! -d "' + state["pio.vm"].prefixPath + '/log" ]; then mkdir ' + state["pio.vm"].prefixPath + '/log; fi',
                                    'if [ ! -d "' + state["pio.vm"].prefixPath + '/run" ]; then mkdir ' + state["pio.vm"].prefixPath + '/run; fi',
                                    'if [ ! -d "' + state["pio.vm"].prefixPath + '/services" ]; then mkdir ' + state["pio.vm"].prefixPath + '/services; fi',
                                    // Put `<prefix>/bin` onto system-wide PATH.
                                    'if [ ! -f "/etc/profile.d/pio.sh" ]; then',
                                    '  sudo touch /etc/profile.d/pio.sh',
                                    "  sudo chown -f " + state["pio.vm"].user + ":" + state["pio.vm"].user + " /etc/profile.d/pio.sh",
                                    // TODO: Get `pio._config.env.PATH` from `state["pio"].env`.
                                    '  echo "export PATH=' + pio._config.env.PATH.replace(/\$/g, "\\\$") + '" > /etc/profile.d/pio.sh',
                                    '  sudo chown root:root /etc/profile.d/pio.sh',
                                    'fi',
                                    'if [ ! -f "' + state["pio.vm"].prefixPath + '/bin/activate.sh" ]; then',
                                    '  echo "#!/bin/sh -e\nexport PATH=' + state["pio.vm"].prefixPath + '/bin:$PATH\n" > ' + state["pio.vm"].prefixPath + '/bin/activate.sh',
                                    "  sudo chown -f " + state["pio.vm"].user + ":" + state["pio.vm"].user + " " + state["pio.vm"].prefixPath + '/bin/activate.sh',
                                    'fi',
                                    "sudo chown -f " + state["pio.vm"].user + ":" + state["pio.vm"].user + " " + state["pio.vm"].prefixPath + '/*',
                                    // NOTE: When deploying as root we need to give the group write access to allow other processes to access the files.
                                    // TODO: Narrow down file access by using different users and groups for different services depending on their relationships.
                                    "sudo chmod -Rf g+wx " + state["pio.vm"].prefixPath
                                ], "/").then(function() {
                                    return ensurePrerequisites(true);
                                });
                            }
                            var sudoCommand = "";
                            if (state["pio.vm"].user !== "root") {
                                sudoCommand = "sudo ";
                            }
                            return runRemoteCommands([
                                    'if [ ! -d "' + state["pio.service.deployment"].path + '" ]; then',
                                    '  ' + sudoCommand + 'mkdir -p ' + state["pio.service.deployment"].path,
                                    "  " + sudoCommand + "chown -f " + state["pio.vm"].user + ":" + state["pio.vm"].user + " " + state["pio.service.deployment"].path,
                                    // NOTE: When deploying as root we need to give the group write access to allow other processes to access the files.
                                    // TODO: Narrow down file access by using different users and groups for different services depending on their relationships.
                                    "  " + sudoCommand + "chmod -f g+wx " + state["pio.service.deployment"].path,
                                    'fi',
                                    // NOTE: When deploying as root we need to give the group write access to allow other processes to access the files.
                                    // TODO: Narrow down file access by using different users and groups for different services depending on their relationships.
                                    sudoCommand + 'chmod -f g+wx "' + state["pio.service.deployment"].path + '/sync" || true',
                                    'if [ ! -f /etc/profile.d/pio.sh ]; then echo "[pio:trigger-ensure-prerequisites]"; fi'
                            ], state["pio.vm"].prefixPath).then(function(response) {
                                if (/\[pio:trigger-ensure-prerequisites\]/.test(response.stdout)) {
                                    return ensureGlobalPrerequisites();
                                }
                            }).fail(function(err) {
                                if (/cannot create directory .*? Permission denied/.test(err.message)) {
                                    return ensureGlobalPrerequisites();
                                }
                                throw err;
                            });
                        }

                        function syncSource() {
                            // TODO: Use walker to get file list using sane deploy ignore rules.
                            //       Feed file list to rsync.
                            var deployIgnoreRulesPath = PATH.join(state["pio.service"].path, "source/.deployignore");
                            console.log("Looking for rsync ignore rules at: " + deployIgnoreRulesPath)
                            return pio.API.RSYNC.sync({
                                sourcePath: state["pio.service"].path,
                                targetUser: state["pio.vm"].user,
                                targetHostname: state["pio.vm"].ip,
                                targetPath: PATH.join(state["pio.service.deployment"].path, "sync"),
                                keyPath: state["pio"].keyPath,
                                excludeFromPath: FS.existsSync(deployIgnoreRulesPath) ? deployIgnoreRulesPath : null,
                                delete: true
                            });
                        }

                        function triggerPostdeploy() {
                            var commands = [];
                            commands.push('. /opt/bin/activate.sh');
                            for (var name in state["pio.service.deployment"].env) {
                                commands.push('export ' + name + '="' + state["pio.service.deployment"].env[name] + '"');
                            }
                            if (state["pio.cli.local"].force) {
                                commands.push('export PIO_FORCE=' + state["pio.cli.local"].force);
                            }
                            commands.push('export PIO_SCRIPTS_PATH="' + PATH.join(state["pio.service.deployment"].path, "sync/scripts") + '"');
                            commands.push('echo "Calling \'postdeploy.sh\' on VM (cwd: ' + state["pio.service.deployment"].path + '):"');
                            // NOTE: When deploying as root we need to give the group write access to allow other processes to access the files.
                            // TODO: Narrow down file access by using different users and groups for different services depending on their relationships.
                            commands.push('chmod -Rf g+wx sync/scripts');
                            commands.push('sh sync/scripts/postdeploy.sh');
                            return runRemoteCommands(commands, state["pio.service.deployment"].path);
                        }

                        return ensurePrerequisites().then(function() {
                            return syncSource();
                        }).then(function() {
                            return triggerPostdeploy();
                        }).then(function() {

                            console.log("Deploy done!");

                            // NOTE: If deploying the `pio.server` we now need to reset out
                            //       connection to the server.
                            if (state["pio.service"].id === "pio.server") {
                                console.log("Reconnecting to pio server...");
                                function reconnect() {
                                    return pio._state["pio.deploy"]._reconnect().then(function(status) {
                                        if (status.status === "ready") {
                                            return;
                                        }
                                        console.log("Warning: Reconnect failed");
                                        console.log("Waiting for 3 seconds and trying again ...");
                                        return Q.delay(1 * 1000).then(function() {
                                            return reconnect();
                                        });
                                    });
                                }
                                return Q.timeout(reconnect(), 10 * 1000).then(function() {
                                    console.log("Reconnect done!");
                                }).fail(function(err) {
                                    console.error("Error reconnecting!");
                                    throw err;
                                });
                            }
                            return;
                        });

/*
                        function defaultDeployPlugin(serviceConfig) {

                            var ignoreRulesPath = PATH.join(state["pio.service"].path, ".deployignore");

                            return pio.API.RSYNC.sync({
                                sourcePath: state["pio.service"].path,
                                targetUser: state["pio.vm"].user,
                                targetHostname: state["pio.vm"].ip,
                                targetPath: state["pio.service.deployment"].path,
                                keyPath: state["pio"].keyPath,
                                excludeFromPath: FS.existsSync(ignoreRulesPath) ? ignoreRulesPath : null
                            }).then(function() {
                                return uploadSource(
                                    PATH.join(state["pio.service.deployment"].path, ".pio.json"),
                                    JSON.stringify(serviceConfig, null, 4)
                                ).then(function() {

                                    if (!FS.existsSync(PATH.join(state["pio.service"].path, "postdeploy.sh"))) {
                                        console.log("Skipping postdeploy. No postdeploy.sh file found!".yellow);
                                        return;
                                    }

                                    var commands = [];
                                    for (var name in serviceConfig.env) {
                                        commands.push('echo "Setting \'"' + name + '"\' to \'"' + serviceConfig.env[name] + '"\'"');
                                        if (state["pio.cli.local"].force) {
                                            commands.push('export PIO_FORCE=' + state["pio.cli.local"].force);
                                        }
                                        commands.push('export ' + name + '=' + serviceConfig.env[name]);
                                    }
                                    commands.push('echo "Calling postdeploy script:"');
                                    commands.push("sh postdeploy.sh");
                                    return runRemoteCommands(commands, state["pio.service.deployment"].path);
                                });
                            }).fail(function(err) {
                                if (/Operation timed out/.test(err.message)) {
                                    throw new Error("Looks like we cannot connect to IP: " + state["pio.vm"].ip);
                                }
                                throw err;
                            });;
                        }

                        return defaultDeployPlugin(serviceConfig);
*/

                    }).fail(function(err) {
                        if (/\/opt\/bin\/activate\.sh: No such file or directory/.test(err.message)) {
                            console.log(("Looks like /opt/bin/activate.sh does not exist on instance. Let's create it along with other prerequisites.").magenta);
                            if (state["pio.deploy"]._repeatAfterProvisionPrerequisites) {
                                console.error(err.stack);
                                throw new Error("We already tried to provision the prerequisites but that failed. You need to resolve manually!");
                            }
                            return ensurePrerequisites().then(function() {
                                state["pio.deploy"]._repeatAfterProvisionPrerequisites = true;
                                return exports.deploy(pio, state);
                            });
                        }
                        throw err;
                    }).then(function() {

                        return pio._state["pio.service"].getFileInfo().then(function (syncFiletreeInfo) {
                            return Q.denodeify(FS.outputFile)(state["pio.deploy"].fileinfoPath, JSON.stringify(syncFiletreeInfo, null, 4));
                        });

                    }).then(function() {

                        response.status = "done";
                    });
                });
            }

            return deploy().fail(function(err) {
                if (
                    /Connection refused/.test(err.message) ||
                    /Operation timed out/.test(err.message)
                ) {
                    if (count >= 30) {
                        throw new Error("Stopping after " + count + " attempts! Cannot connect to IP: " + state["pio.vm"].ip);
                    }
                    console.log("Trying again in 3 seconds ...");
                    var deferred = Q.defer();
                    setTimeout(function() {
                        return attempt(count).then(deferred.resolve).fail(deferred.reject);
                    }, 3000);
                    return deferred.promise;
                }
                throw err;
            });
        }
        return attempt(0);
    }).then(function() {
        return pio.API.Q.resolve({
            "pio.deploy": response
        });
    });
}
