var reportParser = require('../util/report-parser.js')
var _ = require('lodash');
var db = require('../db');
var superagent = require('superagent');

var addReport = function( report, options, callback ) {
	options = _.clone(options);
	options.report = _.cloneDeep(report);
	options.status = "unknown";
	if ( options.report.bulkAggregates ) // version <= 3
	{
		if ( options.report.bulkAggregates.max == 0 )
			options.status = "failed";
		else
			options.status = "ok";
	}

	console.log(options);
	db.collection('reports').insert( options, function(err, reports) {
		if ( err )
		{
			console.error("Failed to insert report!")
		}
		var report = reports[0];
		if ( options.owner )
			db.collection('webhooks').find({ owner: options.owner }).toArrayAsync()
				.then(function(hooks) {
					_.forEach( hooks, function(hook) {
						superagent.post(hook.url).send(report).end(function(e, res) {
							if ( e )
								console.error("WebHook Error : " + e);
							else if ( res.status != 200 && res.status != 201 )
								console.error("WebHook Failed : " + res);
							else
								console.log("Successfully posted webhook to " + hook.url);
						})
					})
				});
		callback(null, report);
	} );
	db.collection('monitors').update({_id: options.monitors_id}, { $set: { status: options.status, last_report_time: report.received_at, last_report_timestamp: report.report.timestamp } }, { multi: false }, function (err, numReplaced) {
		console.log(err, numReplaced);
	})
}

var parseReport = function( options, monitor )
{
	var lastReportTime = null, lastReportTimestamp = null;
	if ( monitor )
	{
		lastReportTime = monitor.last_report_time;
		lastReportTimestamp = monitor.last_report_timestamp;
	}

	var report = null;
	try
	{
		console.log( options.content )
		report = reportParser(options.content, options.received_at, lastReportTime, lastReportTimestamp);
		if ( !options.gsmid && ( !report.uuid && report.uuid != 0 ) )
			return callback( "No momo identifier found in report." );
	}
	catch (e)
	{
		console.log(e);
		console.log("Report parsing error");
		return callback( "Report parsing error." );
	}

	if ( !report.uuid )
	{
		console.error( "Report does not have a valid UUID!" );
		return;
	}
}

var processReport = function( options, callback ) {
	options.received_at = new Date().getTime();
	console.log(options);
	if ( !options.content )
		return callback( "Bad report processor arguments." );
	
	var query = {uuid: report.uuid}
	db.collection('monitors').findOneAsync(query)
	.then(function(doc) {
		console.log(doc);

		parseReport( options, doc );

		if ( !doc )
		{
			db.collection('monitors').insert({
				name: "New monitor (" + report.uuid + ")",
				location: [0,0],
				uuid: report.uuid,
				status: "unknown"
			}, function( err, results ) {
				console.log(err);
				if ( err )
					options.monitors_id = null;
				else
					options.monitors_id = results[0]._id.toString();

				addReport( report, options, callback );
			})
		}
		else
		{
			options.monitors_id = doc._id.toString();
			if ( doc.owner )
				options.owner = doc.owner;
			addReport( report, options, callback );
		}
	})
	.catch(function(err) {
		console.log(err);
	});
}

module.exports = processReport;