var reportParser = require('../util/report-parser.js')
var _ = require('lodash');
var db = require('../db');
var superagent = require('superagent');

var addReport = function( rawReport, data, options, callback ) {
	options = _.clone(options);
	options.report = _.cloneDeep(rawReport);
	options.data = data;
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
	db.collection('monitors').update({_id: db.ObjectID(options.monitors_id)}, { $set: { status: options.status, last_report_time: options.received_at, last_report_timestamp: rawReport.timestamp } }, { multi: false }, function (err, numReplaced) {
		console.log(err, numReplaced);
	})
}

function resolveTimestamp( reportTimestamp, reportTime, lastReportTime, lastReportTimestamp, entryTimestamp )
{
  console.log(reportTimestamp, reportTime, lastReportTime, lastReportTimestamp, entryTimestamp);
  if ( !lastReportTime || !lastReportTimestamp )
  {
    return reportTime - ((reportTimestamp - entryTimestamp)*1000);
  }
  else
  {
    var timeDelta = reportTime - lastReportTime;
    var timestampDelta = reportTimestamp - lastReportTimestamp;
    var skewFactor = timeDelta / timestampDelta;
    console.log(skewFactor);
    return Math.floor(lastReportTime + ((entryTimestamp - lastReportTimestamp)*skewFactor));
  }
}
function createNormalizedData( report, reportTime, monitor )
{
	if ( report.version < 4 )
		return {};
	var data = {};
	var lastReportTime = null, lastReportTimestamp = null;
	if ( monitor )
	{
		lastReportTime = monitor.last_report_time;
		lastReportTimestamp = monitor.last_report_timestamp;
	}
	data['battery'] = [[reportTime, report.batteryVoltage]];
	for ( var i = 0; i < report.entries.length; ++i )
	{
		var entry = report.entries[i];
		if ( !data[entry.streamID] )
		{
	      data[entry.streamID] = [];
		}

	    resolved_timestamp = resolveTimestamp(report.timestamp, reportTime, lastReportTime, lastReportTimestamp, entry.timestamp);
	    data[entry.streamID].push([resolved_timestamp, entry.value]);
	}
	return data;
}

var parseReport = function( options, callback )
{
	var report = null;
	try
	{
		console.log( options.content )
		report = reportParser(options.content);
		if ( !options.gsmid && ( !report.uuid && report.uuid != 0 ) )
			return callback( "No momo identifier found in report." );
	}
	catch (e)
	{
		console.log(e);
		return callback( "Report parsing error." );
	}

	if ( !report.uuid )
	{
		return callback( "Report does not have a valid UUID!" );
	}

	callback( null, report );
}

var processReport = function( options, callback ) {
	options.received_at = new Date().getTime();
	console.log(options);
	if ( !options.content )
		return callback( "Bad report processor arguments." );
	
	parseReport(options, function(err, rawReport) {
		if ( err )
			callback( err );

		var query = {uuid: rawReport.uuid}
		db.collection('monitors').findOneAsync(query)
		.then(function(doc) {
			console.log(doc);

			if ( !doc )
			{
				db.collection('monitors').insert({
					name: "New monitor (" + rawReport.uuid + ")",
					location: [0,0],
					uuid: rawReport.uuid,
					status: "unknown"
				}, function( err, results ) {
					console.log(err);
					var data = {};
					if ( err )
					{
						options.monitors_id = null;
					}
					else
					{
						options.monitors_id = results[0]._id.toString();
						data = createNormalizedData( rawReport, options.received_at, results[0] )
					}

					addReport( rawReport, data, options, callback );
				})
			}
			else
			{
				options.monitors_id = doc._id.toString();
				if ( doc.owner )
					options.owner = doc.owner;
				var data =  createNormalizedData(rawReport, options.received_at, doc);
				addReport( rawReport, data, options, callback );
			}
		})
		.catch(function(err) {
			console.log(err);
		});
	});
}

module.exports = processReport;