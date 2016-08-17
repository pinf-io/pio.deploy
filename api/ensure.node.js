

exports.forLib = function (LIB) {
    var ccjson = this;


    const RUNBASH = require("runbash");


    function deploy (config) {

        // TODO: Check using request to target to see if already deployed so we
        //       can skip the slow ssh connection.

        var vm = config.vm();

        return RUNBASH([
            'ssh \\',
      			'-o ConnectTimeout=5 \\',
      			'-o ConnectionAttempts=1 \\',
      			'-o UserKnownHostsFile=/dev/null \\',
      			'-o StrictHostKeyChecking=no \\',
      			'-o UserKnownHostsFile=/dev/null \\',
      			'-o IdentityFile=' + vm.private.keyPath + ' \\',
      			vm.user + '@' + vm.ip + ' \\',
      			'bash -e -s << EOF',
                'if ! which perl; then',
                // TODO: Install these automatically when installing 'bash.origin.provision' where the
                //       plugin declares the OS commands it needs.
                '   sudo yum install -y perl unzip git',
                'fi',
                'if [ ! -e "\\$HOME/.bash.origin" ]; then',
                '    curl -s -o "\\$HOME/.bash.origin" "https://raw.githubusercontent.com/bash-origin/bash.origin/master/bash.origin?t=$(date +%s)"',
                'fi',
                'export SHELL="/bin/bash"',
                'export BO_VERSION_NVM_NODE=' + process.env.BO_VERSION_NVM_NODE || '5',
                '. "\\$HOME/.bash.origin"',
                'BO_callPlugin "bash.origin.provision@master" BO_Provision_ensureGitWorkingRepositoryAt "' + config.target.path + '" "' + config.source.url + '"',
                'pushd "' + config.target.path + '"',
                // TODO: Make installation more powerful.
                '    if [ -e "package.json" ]; then',
                '        if [ ! -e ".installed" ]; then',
                '            BO_run_npm install --production',
                '            touch ".installed"',
                '        fi',
                '    fi',
                'popd',
                config.run.command,
             'EOF',
        ], {
            progress: true,
            wrappers: {
                "bash.origin": true
            }
            /*
            exports: {
                "URL": true
            }
            */
        }).then(function () {

            process.exit(1);

            return null;
        });
    }


    return LIB.Promise.resolve({
        forConfig: function (defaultConfig) {

            var Entity = function (instanceConfig) {
                var self = this;

                var config = {};
                LIB._.merge(config, defaultConfig);
                LIB._.merge(config, instanceConfig);
                config = ccjson.attachDetachedFunctions(config);


                function ensure () {
                    if (!ensure._promise) {

                        ensure._promise = deploy(config);
                    }
                    return ensure._promise;
                }

                self.AspectInstance = function (aspectConfig) {

                    var config = {};
                    LIB._.merge(config, defaultConfig);
                    LIB._.merge(config, instanceConfig);
                    LIB._.merge(config, aspectConfig);
                    config = ccjson.attachDetachedFunctions(config);

                    return ensure().then(function (rt) {
                        return {
                            api: function () {
                                return LIB.Promise.resolve(
                                    ccjson.makeDetachedFunction(function (args) {

                                        var exports = {};

                                        return exports;
                                    })
                                );
                            }
                        };
                    });
                }
            }

            return Entity;
        }
    });
}
