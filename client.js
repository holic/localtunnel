var net = require('net');
var url = require('url');
var EventEmitter = require('events').EventEmitter;

var request = require('request');
var debug = require('debug')('localtunnel:client');

var stream = require('stream');
var util = require('util');

var Transform = stream.Transform;

var HeaderHostTransformer = function(opts) {
    if (!(this instanceof HeaderHostTransformer)) {
        return new HeaderHostTransformer(opts);
    }

    opts = opts || {}
    Transform.call(this, opts);

    var self = this;
    self.host = opts.host || 'localhost';
}
util.inherits(HeaderHostTransformer, Transform);

HeaderHostTransformer.prototype._transform = function (chunk, enc, cb) {
    var self = this;
    chunk = chunk.toString();

    // after replacing the first instance of the Host header
    // we just become a regular passthrough
    self.push(chunk.replace(/(\r\nHost: )\S+/, function(match, $1) {
        self._transform = undefined;
        return $1 + self.host;
    }));
    cb();
};

var PathTransformer = function(opts) {
    if (!(this instanceof PathTransformer)) {
        return new PathTransformer(opts);
    }

    opts = opts || {}
    Transform.call(this, opts);

    var self = this;
    self.path = opts.path || '';
}
util.inherits(PathTransformer, Transform);

PathTransformer.prototype._transform = function (chunk, enc, cb) {
    var self = this;
    chunk = chunk.toString();

    // after prepending to the first instance of a path
    // we just become a regular passthrough
    self.push(chunk.replace(/(\/)/, function(match, $1) {
        delete self._transform;
        return self.path + $1;
    }));
    cb();
};

// manages groups of tunnels
var TunnelCluster = function(opt) {
    if (!(this instanceof TunnelCluster)) {
        return new TunnelCluster(opt);
    }

    var self = this;
    self._opt = opt;

    EventEmitter.call(self);
};

TunnelCluster.prototype.__proto__ = EventEmitter.prototype;

// establish a new tunnel
TunnelCluster.prototype.open = function() {
    var self = this;

    var opt = self._opt || {};

    var remote_host = opt.remote_host;
    var remote_port = opt.remote_port;

    var local_host = opt.local_host;
    var local_port = opt.local_port;
    var local_path = opt.local_path;

    debug('establishing tunnel %s:%d%s <> %s:%d', local_host, local_port, local_path, remote_host, remote_port);

    // connection to localtunnel server
    var remote = net.connect({
        host: remote_host,
        port: remote_port
    });

    remote.once('error', function(err) {
        // emit connection refused errors immediately, because they
        // indicate that the tunnel can't be established.
        if (err.code === 'ECONNREFUSED') {
            self.emit('error', new Error('connection refused: ' + remote_host + ':' + remote_port + ' (check your firewall settings)'));
        }
        else {
            self.emit('error', err);
        }

        setTimeout(function() {
            self.emit('dead');
        }, 1000);
    });

    function conn_local() {
        if (remote.destroyed) {
            debug('remote destroyed');
            self.emit('dead');
            return;
        }

        debug('connecting locally to %s:%d%s', local_host, local_port, local_path);
        remote.pause();

        // connection to local http server
        var local = net.connect({
            host: local_host,
            port: local_port
        });

        function remote_close() {
            debug('remote close');
            self.emit('dead');
            local.end();
        };

        remote.once('close', remote_close);

        // TODO some languages have single threaded servers which makes opening up
        // multiple local connections impossible. We need a smarter way to scale
        // and adjust for such instances to avoid beating on the door of the server
        local.once('error', function(err) {
            debug('local error %s', err.message);
            local.end();

            remote.removeListener('close', remote_close);

            if (err.code !== 'ECONNREFUSED') {
                return remote.end();
            }

            // retrying connection to local server
            setTimeout(conn_local, 1000);
        });

        local.once('connect', function() {
            debug('connected locally');
            remote.resume();

            var stream = remote;

            // if user requested something other than localhost
            // then we use host header transform to replace the host header
            if (local_host !== 'localhost') {
                stream = stream.pipe(HeaderHostTransformer({ host: local_host }));
            }

            if (local_path !== '') {
                stream = stream.pipe(PathTransformer({ path: local_path }));
            }

            stream.pipe(local).pipe(remote);

            // when local closes, also get a new remote
            local.once('close', function(had_error) {
                debug('local connection closed [%s]', had_error);
            });
        });
    }

    // tunnel is considered open when remote connects
    remote.once('connect', function() {
        self.emit('open', remote);
        conn_local();
    });
};

var Tunnel = function(opt) {
    if (!(this instanceof Tunnel)) {
        return new Tunnel(opt);
    }

    var self = this;
    self._closed = false;
    self._opt = opt || {};

    self._opt.host = self._opt.host || 'https://localtunnel.me';
};

Tunnel.prototype.__proto__ = EventEmitter.prototype;

// initialize connection
// callback with connection info
Tunnel.prototype._init = function(cb) {
    var self = this;
    var opt = self._opt;

    var params = {
        path: '/',
        json: true
    };

    var base_uri = opt.host + '/';

    // optionally override the upstream server
    var upstream = url.parse(opt.host);

    // no subdomain at first, maybe use requested domain
    var assigned_domain = opt.subdomain;

    // where to quest
    params.uri = base_uri + ((assigned_domain) ? assigned_domain : '?new');

    (function get_url() {
        request(params, function(err, res, body) {
            if (err) {
                // TODO (shtylman) don't print to stdout?
                console.log('tunnel server offline: ' + err.message + ', retry 1s');
                return setTimeout(get_url, 1000);
            }

            if (res.statusCode !== 200) {
                var err = new Error((body && body.message) || 'localtunnel server returned an error, please try again');
                return cb(err);
            }

            var port = body.port;
            var host = upstream.hostname;

            var max_conn = body.max_conn_count || 1;

            cb(null, {
                remote_host: upstream.hostname,
                remote_port: body.port,
                name: body.id,
                url: body.url,
                max_conn: max_conn
            });
        });
    })();
};

Tunnel.prototype._establish = function(info) {
    var self = this;
    var opt = self._opt;

    info.local_host = opt.local_host || 'localhost';
    info.local_port = opt.port;
    info.local_path = opt.path || '';

    var tunnels = self.tunnel_cluster = TunnelCluster(info);

    // only emit the url the first time
    tunnels.once('open', function() {
        self.emit('url', info.url);
    });

    var tunnel_count = 0;

    // track open count
    tunnels.on('open', function(tunnel) {
        tunnel_count++;
        debug('tunnel open [total: %d]', tunnel_count);

        var close_handler = function() {
            tunnel.destroy();
        };

        if (self._closed) {
            return close_handler();
        }

        self.once('close', close_handler);
        tunnel.once('close', function() {
            self.removeListener('close', close_handler);
        });
    });

    // when a tunnel dies, open a new one
    tunnels.on('dead', function(tunnel) {
        tunnel_count--;
        debug('tunnel dead [total: %d]', tunnel_count);

        if (self._closed) {
            return;
        }

        tunnels.open();
    });

    // establish as many tunnels as allowed
    for (var count = 0 ; count < info.max_conn ; ++count) {
        tunnels.open();
    }
};

Tunnel.prototype.open = function(cb) {
    var self = this;

    self._init(function(err, info) {
        if (err) {
            return cb(err);
        }

        self.url = info.url;
        self._establish(info);
        cb();
    });
};

// shutdown tunnels
Tunnel.prototype.close = function() {
    var self = this;

    self._closed = true;
    self.emit('close');
};

module.exports = function localtunnel(port, opt, fn) {
    if (typeof opt === 'function') {
        fn = opt;
        opt = {};
    }

    opt = opt || {};
    opt.port = port;

    var client = Tunnel(opt);
    client.open(function(err) {
        if (err) {
            return fn(err);
        }

        fn(null, client);
    });
};
