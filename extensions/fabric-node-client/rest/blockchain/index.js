'use strict'

const path = require('path');
const util = require('util');

const FabricClient = require('fabric-client');
const serviceConfig = require('../../services.json');

const networkConfig = path.join(__dirname, '..', '..', serviceConfig.networkConfig);
const orgConfig = path.join(__dirname, '..', '..', serviceConfig.orgConfig);

const log4js = require('log4js');
const logger = log4js.getLogger('blockchain');
logger.level = 'debug';

/* 
Method: 
    getClient
Description: 
    Method to return a Fabric client object that has been properly enrolled with
              a particular credential.
Params:
- enrollmentID: A name that has been registered in the Fabric CA
- enrollmentSecrets: A password that is associated with the enrollmentID

Return: {
   success: <true | false>,
   payload: {
		client: [client type],
		enrolledUserObj: [object representing user credential]
   },
   message: <string>
}
*/
module.exports.getClient = async (enrollmentID, enrollmentSecrets) => {

	try {
		FabricClient.setLogger(logger);
		const client = FabricClient.loadFromConfig(networkConfig);
		client.loadFromConfig(orgConfig);
		await client.initCredentialStores();
		let enrolledUserObj = await client.getUserContext(enrollmentID, true);
		if (enrolledUserObj == null) {
			enrolledUserObj = await client.setUserContext({ username: enrollmentID, password: enrollmentSecrets });
		}
		return {
			success: true,
			payload: {
				client: client,
				enrolledUserObj: enrolledUserObj
			},
			message: `Returned payload {
				client: ${client},
				enrolledUserObj: ${enrolledUserObj}
			}`,
		};
	} catch (error) {
		return {
			success: false,
			payload: null,
			message: `Failed: ${error.toString()}`
		};
	}
}

/*
Method: 
   registerUser
Description: 
    A method to register a user with a ID on the CA by an admin (pre-registered credential) 
Params:
  - client: Fully enrolled client
  - enrolledUserObj: Identity user enrolled with the client
  - registrantID: Identity of the credential to be registered
Return: {
   success: <true | false>,
   payload: {
	    registrantID: registrant identity in string,
		  registrantSecret: registrate password generated by CA
   },
   message: <string>
}
*/
module.exports.registerUser = async (client, enrolledObj, registrantID) => {

	let user = await client.getUserContext(registrantID, true);

	let secret = null;
	if (user && user.isEnrolled()) {
		logger.info('Successfully loaded member from wallet');
	} else {
		logger.info('User was not enrolled, so we are enrolling with bootstrapping credentials');
		try{
			const caClient = client.getCertificateAuthority();
			const registrantSecret = await caClient.register({
				enrollmentID: registrantID,
				affliation: 'org1.department1' // Settings from Fabric CA
			}, enrolledObj);
	
			if (registrantSecret != null || registrantSecret != undefined) {
				return {
					success: true,
					payload: {
						registrantID: registrantID,
						registrantSecret: registrantSecret
					},
					message: `Return payload {
						registrantID: ${registrantID},
						registrantSecret: ${registrantSecret}
					}`
				};
			} else {
				return {
					success: false,
					payload: null,
					message: `Failed: Unable to register ${registrantID}`
				};
			}
		}catch(error){
			return {
				success: false,
				payload: null,
				message: `Failed: ${error.toString()}`
			};
		}
		
	
	}
}

/*
Method: 
   proposeTransaction
Description: 
   A method to send proposal to peers for a given enrollment 
Params:
  - client: A successfully enrolled client
  - fcn: A function in the chaincode to be executed
  - args: Arguments associated with a function
Return: {
   success: <true | false>,
   payload: {
	    registrantID: registrant identity in string,
		registrantSecret: registrate password generated by CA
   },
   message: <string>
}
*/
module.exports.proposeTransaction = async (client, fcn, args) => {

	let request = {
		targets: serviceConfig.blockchain.targets,
		chaincodeId: serviceConfig.blockchain.chaincodeName,
		fcn: fcn,
		args: args,
		chainId: serviceConfig.blockchain.channelName
	}

	let txIDString = null;

	const txId = client.newTransactionID();
	request.txId = txId;
	txIDString = txId.getTransactionID();
	const channel = client.getChannel(serviceConfig.blockchain.channelName);

	logger.debug('request.targets --->: ' + request.targets);
	logger.debug('request.chaincodeId --->: ' + request.chaincodeId);
	logger.debug('request.chainId --->: ' + request.chainId);
	logger.debug('request.txId --->: ' + request.txId);

	let results = null;

	try {
		results = await channel.sendTransactionProposal(request);
		logger.debug('result of proposal --->: ' + results);
	} catch (error) {
		return {
			success: false,
			payload: null,
			message: `Failed proposal: ${error.toString()}`
		};
	}

	let proposalResponses = results[0];
	let proposal = results[1];

	let all_good = true;
	for (var i in proposalResponses) {
		let one_good = false;
		if (proposalResponses && proposalResponses[i].response &&
			proposalResponses[i].response.status === 200) {
			one_good = true;
			logger.info('invoke chaincode proposal was good');
		} else {
			logger.error('invoke chaincode proposal was bad');
		}
		all_good = all_good & one_good;
	}

	if (all_good) {
		return {
			success: true,
			payload: {
				txId: txId,
				txIDString: txIDString,
				proposalResponses: proposalResponses,
				proposal: proposal
			},
			message: `Return payload {
				txID: ${txId}
				txIDString: ${txIDString},
				proposalResponses: ${proposalResponses},
				proposal: ${proposal}
			}`
		};
	} else {
		return {
			success: false,
			payload: null,
			message: "SendProposal: endorsement failure"
		};
	}
}

/*
Method: 
   commitTransaction
Description: 
   A method to commit proposal to peers  
Params:
  - client: A successfully enrolled client
  - proposalResponses: responses from the transaction proposal
  - proposal: Content of the proposal
Return: {
   success: <true | false>,
   payload: {
	    commitStatus: status of response from orderer.,
   },
   message: <string>
}
*/
module.exports.commitTransaction = async (client, txId, proposalResponses, proposal) => {

	const ordererRequest = {
		txId: txId,
		proposalResponses: proposalResponses,
		proposal: proposal
	};

	const channel = client.getChannel(serviceConfig.blockchain.channelName);

	logger.info(util.format('------->>> send transactions : %O', ordererRequest));
	try {
		const result = await channel.sendTransaction(ordererRequest);
		if (result.status) {
			return {
				success: true,
				payload: {
					commitStatus: result.status,
				},
				message: `Return payload {
					commitStatus: ${result.status}
				}`
			};
		} else {
			return {
				success: true,
				payload: {
					commitStatus: result.status,
				},
				message: `Return payload {
					commitStatus: ${result.status}
				}`
			};
		}

	} catch (error) {
		return {
			success: false,
			payload: null,
			message: `Failed attachEventHub: ${error.toString()}`
		};
	}

}

/*
Method: 
   attachEventHub
Description: 
   A method to return messages of eventhubs 
Params:
		- client: A successfully enrolled client
		- txIDString: Transaction ID in string to be inspected by eventhubs
		- delays: The wait time before shutting down eventhubs.
Return: {
   success: <true | false>,
   payload: {
	    message: message from eventhub
   },
   message: <string>
}
*/
module.exports.attachEventHub = async (client,txIDString,delays) => {
	let promises = [];
	const channel = client.getChannel(serviceConfig.blockchain.channelName);
	const eventHubs = channel.getChannelEventHubsForOrg();
	eventHubs.forEach((eventHub) => {
		let commitPromse = new Promise((resolve, reject) => {
			let eventTimeout = setTimeout(() => {
				const message = 'REQUEST_TIMEOUT:' + eventHub.getPeerAddr();
				logger.error(message);
				eventHub.disconnect();
			}, delays);
			try{
				eventHub.registerTxEvent(
					txIDString, 
					(tx, code, block_num) => {
						logger.info('The chaincode invoke chaincode transaction has been committed on peer %s', eventHub.getPeerAddr());
						logger.info('Transaction %s has status of %s in blocl %s', tx, code, block_num);
						clearTimeout(eventTimeout);
	
						if (code !== 'VALID') {
							const message = util.format('The commit chaincode transaction was invalid, code:%s', code);
							logger.error(message);
							resolve({
								success: false,
								payload: null,
								message: `Failed: ${message}`
							});
						} else {
							let message = 'The commit chaincode transaction was valid.';
							logger.info(message);
							resolve({
								sucess: true,
								payload: {
									message: message
								},
								message: `Return payload{
										message: ${message}
									}`
							});
						}
					}, 
					(err) => {
						clearTimeout(eventTimeout);
						logger.error(err);
						resolve({
							success: false,
							payload: null,
							message: `Failed: ${err.toString()}`
						});
					},
					// the default for 'unregister' is true for transaction listeners
					// so no real need to set here, however for 'disconnect'
					// the default is false as most event hubs are long running
					// in this use case we are using it only once
					{ unregister: true, disconnect: true }
				);
				eventHub.connect();
			}catch(error){
				reject(error);
			}
		});
		promises.push(commitPromse);
	});

	return await Promise.all(promises);
}

/*
Method: 
   queryChaincode
Description: 
   A method to query a chaincode for a given enrollment 
Params:
  - client: A successfully enrolled client
  - fcn: A function in the chaincode to be executed
  - args: Arguments associated with a function
Return: {
   success: <true | false>,
   payload: {
	    registrantID: registrant identity in string,
		registrantSecret: registrate password generated by CA
   },
   message: <string>
}
*/
module.exports.queryChaincode = async (client, fcn, args) => {

	logger.debug('Successfully got the fabric client for the organization "%s"', serviceConfig.blockchain.org);
	const channel = client.getChannel(serviceConfig.blockchain.channelName);
	if (!channel) {
		const message = util.format('Channel %s was not defined in the connection profile', serviceConfig.blockchain.channelName);
		return 	{
			success: false,
			payload: null,
			message: `Failed: ${message}`
		}
	}

	// send query
	const request = {
		targets: serviceConfig.blockchain.targets, //queryByChaincode allows for multiple targets
		chaincodeId: serviceConfig.blockchain.chaincodeName,
		fcn: fcn,
		args: args
	};

	try {

		let responsePayloads = await channel.queryByChaincode(request);
		if (responsePayloads) {

			let responseMessages = [];
			responsePayloads.forEach((payload)=>{
				const message = `query: ${args}
				 result: ${payload.toString('utf8')}`
				responseMessages.push(message);
			});

			logger.debug('-------->', responseMessages);

			return{
				success: true,
				payload: {
					responses: responseMessages
				},
				message: `Return Payload {
					responses: ${responseMessages}
				}`
			}
		} else {
			let message = 'Unable to fulfil query';
			logger.error(message);
			return {
				success: false,
				payload: null,
				message: `Failed: ${message}`
			}
		}
	} catch (error) {
		const message = 'Failed to query due to error: ' + error.stack ? error.stack : error
		logger.error(message);
		return {
			success: false,
			payload: null,
			message: `Failed: ${message}`
		};
	}
}

/*
Method: 
   blockInfo
Description: 
   A method to get the latest blockinfo
Params:
	<none>
Return: {
   success: <true | false>,
   payload: {
	    result: result
   },
   message: <string>
}
*/
module.exports.blockInfo = async ()=>{

	const clientObject = await this.getClient(serviceConfig.adminCred.enrollmentID, serviceConfig.adminCred.enrollmentSecrets);
	if (!clientObject.success){
		return 	{
			success: false,
			payload: null,
			message: `Failed: unable to secure client`
		}
	}

	const client = clientObject.payload.client;
	const channel = await client.getChannel(serviceConfig.blockchain.channelName);
	if (!channel) {
		const message = util.format('Channel %s was not defined in the connection profile', serviceConfig.blockchain.channelName);
		return 	{
			success: false,
			payload: null,
			message: `Failed: ${message}`
		};
	}

	try{
		const result = await channel.queryInfo();
		return {
			success: true,
			payload: {
				result: result
			},
			message: `Return payload {
				result: ${result}
			}`
		};
	}catch(error){
		return 	{
			success: false,
			payload: null,
			message: `Failed: ${message}`
		};
	}
}

/*
Method: 
   getBlockByNumber
Description: 
   A method to query a block from 
Params:
	- blockNumber: A number representing the position of a block in the chain
Return: {
   success: <true | false>,
   payload: {
					reponse: <payload from the response
   },
   message: <string>
}
*/
module.exports.getBlockByNumber = async (blockNumber) => {

	const clientObject = await this.getClient(serviceConfig.adminCred.enrollmentID, serviceConfig.adminCred.enrollmentSecrets);
	if (!clientObject.success){
		return 	{
			success: false,
			payload: null,
			message: `Failed: unable to secure client`
		}
	}

	const client = clientObject.payload.client;

	var channel = client.getChannel(serviceConfig.blockchain.channelName);
	if (!channel) {
		let message = util.format('Channel %s was not defined in the connection profile', serviceConfig.blockchain.channelName);
		logger.error(message);
		return 	{
			success: false,
			payload: null,
			message: `Failed: ${message}`
		}
	}

	try {
		let responsePayload = await channel.queryBlock(parseInt(blockNumber, serviceConfig.blockchain.peer));
		if (responsePayload) {
			logger.debug(responsePayload);
			return{
				success: true,
				payload: {
					reponse: responsePayload
				},
				message: `Return Payload {
					reponse: ${responsePayload}
				}`
			}
		} else {
			const message = 'Unable to fulfil query';
			logger.error(message);
			return {
				success: false,
				payload: null,
				message: `Failed: ${message}`
			}
		}
	} catch (error) {
		const message = 'Failed to query due to error: ' + error.stack ? error.stack : error
		logger.error(message);
		return {
			success: false,
			payload: null,
			message: `Failed: ${message}`
		};
	}

}

/*
Method: 
   getBlockByHash
Description: 
   A method to query a block in the blockchain by hash id 
Params:
	- hash: A hash value representing the identity of a block in the chain
Return: {
   success: <true | false>,
   payload: {
					reponse: <payload from the response
   },
   message: <string>
}
*/
module.exports.getBlockByHash = async (hash) => {

	const clientObject = await this.getClient(serviceConfig.adminCred.enrollmentID, serviceConfig.adminCred.enrollmentSecrets);
	if (!clientObject.success){
		return 	{
			success: false,
			payload: null,
			message: `Failed: unable to secure client`
		}
	}

	const client = clientObject.payload.client;

	logger.debug('Successfully got the fabric client for the organization "%s"', serviceConfig.blockchain.org);
	var channel = client.getChannel(serviceConfig.blockchain.channelName);
	if (!channel) {
		let message = util.format('Channel %s was not defined in the connection profile', serviceConfig.blockchain.channelName);
		logger.error(message);
		return 	{
			success: false,
			payload: null,
			message: `Failed: ${message}`
		}
	}

	try {
		let responsePayload = await channel.queryBlockByHash(Buffer.from(hash), serviceConfig.blockchain.peer);
		if (responsePayload) {
			logger.debug(responsePayload);
			return{
				success: true,
				payload: {
					reponse: responsePayload
				},
				message: `Return Payload {
					reponse: ${responsePayload}
				}`
			};
		} else {
			const message = 'Unable to get block by hash';
			logger.error(message);
			return {
				success: false,
				payload: null,
				message: `Failed: ${message}`
			}
		}
	} catch (error) {
		const message = 'Failed to query due to error: ' + error.stack ? error.stack : error
		logger.error(message);
		return {
			success: false,
			payload: null,
			message: `Failed: ${message}`
		};
	}
};
