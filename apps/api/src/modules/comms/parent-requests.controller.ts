import { Controller } from '@nestjs/common';
import { parentRequestsContract } from '@exatech/contracts';
import { Can, Endpoint, Input, type Args } from '../../core/http';
import { ParentRequestsService } from './parent-requests.service';

@Controller()
export class ParentRequestsController {
  constructor(private readonly svc: ParentRequestsService) {}

  @Endpoint(parentRequestsContract.inbox)
  @Can('academics:students.manage', 'teaching:attendance.mark')
  inbox() {
    return this.svc.inbox();
  }

  @Endpoint(parentRequestsContract.moderate)
  @Can('academics:students.manage')
  moderate(@Input() { params, body }: Args<typeof parentRequestsContract.moderate>) {
    return this.svc.moderate(params.id, body.decision, body.note);
  }

  @Endpoint(parentRequestsContract.reply)
  @Can('academics:students.manage', 'teaching:attendance.mark')
  reply(@Input() { params, body }: Args<typeof parentRequestsContract.reply>) {
    return this.svc.reply(params.id, body.reply);
  }

  @Endpoint(parentRequestsContract.decidePtm)
  @Can('academics:students.manage', 'teaching:attendance.mark')
  decidePtm(@Input() { params, body }: Args<typeof parentRequestsContract.decidePtm>) {
    return this.svc.decidePtm(params.id, body.decision, body.note);
  }
}
