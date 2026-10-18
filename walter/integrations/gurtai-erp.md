# GurtAI ERP (NetSuite-style)
Accounts payable: vendors, vendor bills, GL accounts, subsidiaries.

## Connection
- SuiteTalk-style REST under /erp/services/rest/record/v1 (limit/offset paging, `q=field IS value`)
- Bearer token, injected by the host: GURTAI_TOKEN

## Notes
- Three subsidiaries: GurtAI Inc., GurtAI Ltd, Intercompany Holdings
- Custom body fields (custbody_*) are used by finance; their labels were never filled in
