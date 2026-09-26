export type AttlogRecord = {
	pin: string;
	localTime: string;
	status: number;
	verifyType: number;
	raw: string;
}

export type RejectedLine = {
	line: string;
	reason: string;
}

export type AttlogParseResult = {
	records: AttlogRecord[];
	rejected: RejectedLine[];
}

export function parseAttlog(body: string): AttlogParseResult {
	const records: AttlogRecord[] = [];
	const rejected: RejectedLine[] = [];
	//pin validation
	const PIN_RE = /^[A-Za-z0-9]{1,24}$/;
	//regex date validation
	const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
	
	// terminals may send \r\n
	const lines = body.split(/\r?\n/);
	
	for (const line of lines){
		if (line.trim() === '') continue;
		const [pin, time, status, verify] = line.split('\t');
		
		if (!pin || !PIN_RE.exec(pin)) {
		  	rejected.push({ line, reason: 'invalid pin' });
		  	continue;
		}
		
		const match = TIME_RE.exec(time);
		if (!match) {
			rejected.push({line, reason: "bad time format"});
			
			continue;
		}

		if (!isValidTime(match)) {
		  	rejected.push({ line, reason: 'invalid date' });
		  	continue;
		}

		if (!Number.isInteger(Number(status)) || !Number.isInteger(Number(verify))) { 
			rejected.push({line, reason: 'invalid status/verify'});
			continue;
		}

		records.push({pin, localTime: time, status: Number(status), verifyType: Number(verify), raw: line });
	}
	return { records, rejected };
}

function isValidTime(match: RegExpExecArray): boolean {
  const [, , month, day, hour, minute, second] = match.map(Number);
  return month >= 1 && month <= 12
      && day >= 1 && day <= 31
      && hour <= 23
      && minute <= 59
      && second <= 59;
}
