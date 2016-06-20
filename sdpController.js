// Load the libraries
var tls    = require('tls');
var fs     = require('fs');
var mysql  = require("mysql");
var config = require('./config'); // get our config file
var credentialMaker = require('./sdpCredentialMaker');
var prompt = require("prompt");

const encryptionKeyLenMin = 4;
const encryptionKeyLenMax = 32;
const hmacKeyLenMin = 4;
const hmacKeyLenMax = 128;

// a couple global variables
var db;
var dbPassword = config.dbPassword;
var serverKeyPassword = config.serverKeyPassword;
var myCredentialMaker = new credentialMaker(config);


// check a couple config settings
if(config.encryptionKeyLen < encryptionKeyLenMin
   || config.encryptionKeyLen > encryptionKeyLenMax)
{
  var explanation = "Range is " + encryptionKeyLenMin + " to " + encryptionKeyLenMax;
  throw new sdpConfigException("encryptionKeyLen", explanation);
}

if(config.hmacKeyLen < hmacKeyLenMin
   || config.hmacKeyLen > hmacKeyLenMax)
{
  var explanation = "Range is " + hmacKeyLenMin + " to " + hmacKeyLenMax
  throw new sdpConfigException("hmacKeyLen", explanation);
}


myCredentialMaker.init(startController);

function startController() {
  if(serverKeyPassword || !config.serverKeyPasswordRequired)
    checkDbPassword();
  else
  {
    var schema = {
        properties: {
          password: {
            description: 'Enter server key password',
            hidden: true,
            replace: '*',
            required: true
          }
        }
    };

    prompt.start();

    prompt.get(schema, function(err,result) {
        if(err)
        {
            throw err;
        }
        else
        {
            serverKeyPassword = result.password;
            checkDbPassword();
        }    
    });
  }
}

function checkDbPassword() {
  if(dbPassword)
    startDbPool();
  else
  {
    var schema = {
        properties: {
          password: {
            description: 'Enter database password',
            hidden: true,
            replace: '*',
            required: true
          }
        }
    };

    prompt.start();

    prompt.get(schema, function(err,result) {
        if(err)
            console.log(err);
        else
        {
            dbPassword = result.password;
            startDbPool();
        }    
    });
  }
}

function startDbPool() {
  // set up database pool
  db = mysql.createPool({
    connectionLimit: config.maxConnections,
    host: config.dbHost,
    user: config.dbUser,
    password: dbPassword, //config.dbPassword,
    database: config.dbName,
    debug: false
  });

  startServer();
}


function startServer() {

  // tls server options
  const options = {
    // the server's private key
    key: fs.readFileSync(config.serverKey),
    passphrase: serverKeyPassword,

    // the server's public cert
    cert: fs.readFileSync(config.serverCert),

    // require client certs
    requestCert: true,
    rejectUnauthorized: true,

    // for client certs created by us
    ca: [ fs.readFileSync(config.caCert) ]
  };


  // Start a TLS Server
  var server = tls.createServer(options, function (socket) {

    if(config.debug)
      console.log("Socket connection started");

    var action = null;
    var memberDetails = null;
    var dataTransmitTries = 0;
    var credentialMakerTries = 0;
    var badMessagesReceived = 0;
    var newKeys = null;
    var accessRefreshDue = false;
    
    // Identify the connecting client or gateway
    var sdpId = socket.getPeerCertificate().subject.CN;

    console.log("Connection from SDP ID " + sdpId);

    // Set the socket timeout to watch for inactivity
    if(config.socketTimeout) 
      socket.setTimeout(config.socketTimeout, function() {
        console.error("Connection to SDP ID " + sdpId + " has timed out. Disconnecting.");
        socket.end();
      });

    // Handle incoming requests from members
    socket.on('data', function (data) {
      processMessage(data);
    });
  
    socket.on('end', function () {
      console.log("Connection to SDP ID " + sdpId + " closed.");
    });
  
    socket.on('error', function (error) {
      console.error(error);
    });
  
    // Find sdpId in the database
    db.getConnection(function(error,connection){
      if(error){
        connection.release();
        console.error("Error connecting to database: " + error);
        socket.end();
        return;
      }
      connection.query('SELECT * FROM `sdpid` WHERE `id` = ?', [sdpId], 
      function (error, rows, fields) {
        connection.release();
        if (error) {
          console.error("Query returned error: " + error);
          console.error(error);
          socket.end(JSON.stringify({action: 'database_error'}));
        } else if (rows.length < 1) {
          console.error("SDP ID not found, notifying and disconnecting");
          socket.end(JSON.stringify({action: 'unknown_sdp_id'}));
        } else if (rows.length > 1) {
          console.error("Query returned multiple rows for SDP ID: " + sdpId);
          socket.end(JSON.stringify({action: 'database_error'}));
        } else {
  
          memberDetails = rows[0];
  
          if (config.debug) {
            console.log("Data for client is: ");
            console.log(memberDetails);
          }
  
          // possibly send credential update
          var now = new Date();
          if(now > memberDetails.cred_update_due) {
            handleCredentialUpdate();
          } else {
            socket.write(JSON.stringify({action: 'credentials_good'}));
          }
          
        }  
  
      });
      
      connection.on('error', function(error) {
        console.error("Error from database connection: " + error);
        socket.end();
        return;
      });
      
    });

    // Parse SDP messages 
    function processMessage(data) {
      if(config.debug) {
        console.log("Message Data Received: ");
        console.log(data.toString());
      }

      // Ignore message if not yet ready
      // Clients are not supposed to send the first message
      if(!memberDetails){
        console.log("Ignoring premature message.");
        return;
      }
      
      try {
        var message = JSON.parse(data);
      }
      catch (err) {
        console.error("Error processing the following received data: \n" + data.toString());
        console.error("JSON parse failed with error: " + err);
        handleBadMessage(data.toString());
        return;
      }

      if(config.debug) {
        console.log("Message parsed");
      }

      console.log("Message received from SDP ID " + memberDetails.id);

      if(config.debug) {
        console.log("JSON-Parsed Message Data Received: ");
        for(var myKey in message) {
          console.log("key: " + myKey + "   value: " + message[myKey]);
        }
      }
      
      action = message['action'];
      if (action === 'credential_update_request') {
        handleCredentialUpdate();
      } else if (action === 'credential_update_ack')  {
        handleCredentialUpdateAck();
      } else if (action === 'keep_alive') {
        handleKeepAlive();
      } else if (action === 'access_refresh_request') {
        handleAccessRefresh();
      } else if (action === 'access_update_request') {
        handleAccessUpdate(message);
      } else if (action === 'access_ack') {
        handleAccessAck();
      } else {
        console.error("Invalid message received, invalid or missing action");
        handleBadMessage(data.toString());
      }
    }    
    
    function handleKeepAlive() {
      console.log("Received keep_alive request, responding now");
      var keepAliveMessage = {
        action: 'keep_alive'
      };
      // For testing only, send a bunch of copies fast
      if (config.testManyMessages > 0) {
        console.log("Sending " +config.testManyMessages+ " extra messages first for testing rather than just 1");
        var jsonMsgString = JSON.stringify(keepAliveMessage);
        for(var ii = 0; ii < config.testManyMessages; ii++) {
          socket.write(jsonMsgString);
        }
      }

      socket.write(JSON.stringify(keepAliveMessage));
      //console.log("keepAlive message written to socket");


    }


    function handleCredentialUpdate() {
      if (dataTransmitTries >= config.maxDataTransmitTries) {
        // Data transmission has failed
        console.error("Data transmission to SDP ID " + memberDetails.id + 
          " has failed after " + (dataTransmitTries+1) + " attempts");
        console.error("Closing connection");
        socket.end();
        return;
      }
  
      // get the credentials
      myCredentialMaker.getNewCredentials(memberDetails, function(err, data){
        if (err) {
          
          credentialMakerTries++;
          
          if (credentialMakerTries > config.maxCredentialMakerTries) {
            // Credential making has failed
            console.error("Failed to make credentials for SDP ID " + memberDetails.id +
                      " " + credentialMakerTries + " times.");
            console.error("Closing connection");
            socket.end();
            return;
          }
  
          // otherwise, just notify requestor of error
          var credErrMessage = {
            action: 'credential_update_error',
            data: 'Could not generate new credentials',
          };
  
          console.log("Sending credential_update_error message to SDP ID " + memberDetails.id + ", failed attempt: " + credentialMakerTries);
          socket.write(JSON.stringify(credErrMessage));
  
        } else {
          // got credentials, send them over
          var newCredMessage = {
            action: 'credential_update',
            data
          };
          
          var updated = new Date();
          var expires = new Date();
          expires.setDate(expires.getDate() + config.daysToExpiration);
          expires.setHours(0);
          expires.setMinutes(0);
          expires.setSeconds(0);
          expires.setMilliseconds(0);
          
          newKeys = {
            encryption_key: data.encryption_key,
            hmac_key: data.hmac_key,
            updated,
            expires
          };
  
          console.log("Sending credential_update message to SDP ID " + memberDetails.id + ", attempt: " + dataTransmitTries);
          dataTransmitTries++;
          socket.write(JSON.stringify(newCredMessage));
  
        }
  
      });
    } // END FUNCTION handleCredentialUpdate
    
    
    function handleCredentialUpdateAck()  {
      console.log("Received acknowledgement from requestor, data successfully delivered");

      // store the necessary info in the database
      storeKeysInDatabase();

    }  // END FUNCTION handleCredentialUpdateAck


    function postStoreKeysCallback(error) {
      if(memberDetails.type === 'client') {
        notifyGateways(error);
      }
    }  // END FUNCTION postStoreKeysCallback


    function notifyGateways(error) {
      if ( error ) {
        console.error("Not performing gateway notification for SDP ID " 
                       + memberDetails.id + " due to previous error");
        return;
      }
      
      // TODO notify gateways
      
      // only after successful notification
      if(!config.keepClientsConnected) socket.end();

    } // END FUNCTION notifyGateways
    
    
    function handleAccessRefresh() {
        if (dataTransmitTries >= config.maxDataTransmitTries) {
            // Data transmission has failed
            console.error("Data transmission to SDP ID " + memberDetails.id + 
              " has failed after " + (dataTransmitTries+1) + " attempts");
            console.error("Closing connection");
            socket.end();
            return;
        }

        db.getConnection(function(error,connection){
            if(error){
                connection.release();
                console.error("Error connecting to database: " + error);
                
                // notify the requestor of our database troubles
                socket.write(
                    JSON.stringify({
                        action: 'access_refresh_error',
                        data: 'Database unreachable. Try again soon.'
                    })
                );
                
                return;
            }
            
            connection.query(
                'SELECT ' +
                '    `sdpid_service`.`sdpid_id`,  ' +
                '    `service_gateway`.`protocol_port`, ' +
                '    `sdpid`.`encrypt_key`,  ' +
                '    `sdpid`.`hmac_key` ' +
                'FROM `gateway` ' +
                '    JOIN `service_gateway` ' +
                '        ON `service_gateway`.`gateway_id` = `gateway`.`id` ' +
                '    JOIN `sdpid_service` ' +
                '        ON `sdpid_service`.`service_id` = `service_gateway`.`service_id` ' +
                '    JOIN `sdpid` ' +
                '        ON `sdpid`.`id` = `sdpid_service`.`sdpid_id` ' +
                'WHERE `gateway`.`sdpid_id` = ? ' +
                'ORDER BY `sdpid_id` ',
                [memberDetails.id],
                function (error, rows, fields) {
                    connection.release();
                    if(error) {
                        console.error("Access data query returned error: " + error);
                        socket.write(
                            JSON.stringify({
                                action: 'access_refresh_error',
                                data: 'Database error. Try again soon.'
                            })
                        );
                        return;
                    }
                    
                    var data = [];
                    var dataIdx = 0;
                    var currentSdpId = 0;
                    for(var rowIdx = 0; rowIdx < rows.length; rowIdx++) {
                        var thisRow = rows[rowIdx];
                        dataIdx = data.length - 1;
                        if(thisRow.sdpid_id != currentSdpId) {
                            currentSdpId = thisRow.sdpid_id;
                            data.push({
                                sdp_client_id: thisRow.sdpid_id,
                                source: "ANY",
                                open_ports: thisRow.protocol_port,
                                key_base64: thisRow.encrypt_key,
                                hmac_key_base64: thisRow.hmac_key
                            });
                        } else {
                            data[dataIdx].open_ports += ", " + thisRow.protocol_port;
                        }
                    }
                    
                    if(config.debug) {
                        console.log("Access refresh data to send: \n" + data);
                    }
                    
                    console.log("Sending access_refresh message to SDP ID " + 
                        memberDetails.id + ", attempt: " + dataTransmitTries);
                    dataTransmitTries++;
            
                    socket.write(
                        JSON.stringify({
                            action: 'access_refresh',
                            data
                        })
                    );
                    
                } // END QUERY CALLBACK FUNCTION

            );  // END QUERY DEFINITION
      
            connection.on('error', function(error) {
                console.error("Error from database connection: " + error);
                return;
            });
            
        });  // END DATABASE CONNECTION CALLBACK
        
    }  // END FUNCTION handleAccessRefresh
    
    
    

    function handleAccessUpdate(message) {
      //TODO
      
    }
    
    
    function handleAccessAck()  {
      console.log("Received access data acknowledgement from requestor, data successfully delivered");

      clearStateVars();

    }  // END FUNCTION handleAccessAck


    // store generated keys in database
    function storeKeysInDatabase() {
      if (newKeys.hasOwnProperty('encryption_key') && 
          newKeys.hasOwnProperty('hmac_key')) 
      {
        if(config.debug)
          console.log("Found the new keys to store in database for SDP ID "+sdpId);
        
        db.getConnection(function(error,connection){
          if(error){
            connection.release();
            console.error("Error connecting to database: " + error);
            postStoreKeysCallback(error);
            return;
          }
          connection.query(
            'UPDATE `sdpid` SET ' +
            '`encrypt_key` = ?, `hmac_key` = ?, ' +
            '`last_cred_update` = ?, `cred_update_due` = ? WHERE `id` = ?', 
            [newKeys.encryption_key,
             newKeys.hmac_key,
             newKeys.updated,
             newKeys.expires,
             memberDetails.id],
          function (error, rows, fields){
            connection.release();
            if (error)
            {
              console.error("Failed when writing keys to database for SDP ID "+sdpId);
              console.error(error);
            } else {
              console.log("Successfully stored new keys for SDP ID "+sdpId+" in the database");
            }

            newKeys = null;
            clearStateVars();
            postStoreKeysCallback(error);
          });
          
          connection.on('error', function(error) {
            console.error("Error from database connection: " + error);
            socket.end();
            return;
          });
          
        });

      } else {
        console.error("Did not find keys to store in database for SDP ID "+sdpId);
        clearStateVars();
      }
    }


    // clear all state variables
    function clearStateVars() {
      action = null;
      dataTransmitTries = 0;
      credentialMakerTries = 0;
      badMessagesReceived = 0;
    }


    // deal with receipt of bad messages
    function handleBadMessage(badMessage) {
      badMessagesReceived++;

      console.error("In handleBadMessage, badMessage:\n" +badMessage);

      if (badMessagesReceived < config.maxBadMessages) {

        console.error("Preparing badMessage message...");
        var badMessageMessage = {
          action: 'bad_message',
          data: badMessage
        };

        console.error("Message to send:");
        for(var myKey in badMessageMessage) {
          console.log("key: " + myKey + "   value: " + badMessageMessage[myKey]);
        }
        socket.write(JSON.stringify(badMessageMessage));

      } else {

        console.error("Received " + badMessagesReceived + " badly formed messages from SDP ID " +
          sdpId);
        console.error("Closing connection");
        socket.end();
      }
    }

  }).listen(config.serverPort);

  if(config.maxConnections) server.maxConnections = config.maxConnections;

  // Put a friendly message on the terminal of the server.
  console.log("SDP Controller running at port " + config.serverPort);
}

function sdpQueryException(sdpId, entries) {
  this.name = "SdpQueryException";
  this.message = "SDP ID " + sdpId + " query returned " + entries + " entries";
}

function sdpConfigException(configName, correctiveMessage) {
  this.name = "SdpConfigException";
  this.message = "Invalid entry for " + configName + "\n" + correctiveMessage;
}


