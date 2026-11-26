/** Pure evidence comparisons; retained archive history is never deleted. */
export function reconcileSessionIds(source:Iterable<string>,indexed:Iterable<string>){
 const discovered=new Set(source),stored=new Set(indexed);
 return {matched_sessions:[...discovered].filter(id=>stored.has(id)).length,missing_sessions:[...discovered].filter(id=>!stored.has(id)).length,retained_sessions:[...stored].filter(id=>!discovered.has(id)).length};
}
export function verifyMessageHashes(source:ReadonlyMap<string,string>,indexed:ReadonlyMap<string,string>){
 return {text_parity:source.size===indexed.size&&[...source].every(([id,hash])=>indexed.get(id)===hash)?'verified':'mismatch',verified_messages:source.size};
}
