import { Logger, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { paymentsContract } from '@exatech/contracts';
import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { AcademicsModule } from '../academics/academics.module';
import { AccountsService } from './accounts.service';
import { DashboardService } from './dashboard.service';
import { DayBookService } from './daybook.service';
import { DeskService } from './desk.service';
import { FinanceDocuments } from './documents.service';
import { DuesService } from './dues.service';
import { FinanceMessages } from './finance-messages.service';
import {
  AccountsController,
  DayBookController,
  DeskController,
  DuesController,
  FinanceDashboardController,
  FinanceDocumentsController,
  FinanceSettingsController,
  PortalPaymentsController,
  ReconciliationController,
  RegistersController,
} from './finance.controller';
import { FinanceEvents } from './finance.events';
import { FinanceShared } from './finance.shared';
import { InvoicesService } from './invoices.service';
import { OnlineService } from './online.service';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';
import { RegistersService } from './registers.service';
import { FinanceSettingsService } from './settings.service';

const WEBHOOK_PATHS = new Set([paymentsContract.razorpayWebhookPath, paymentsContract.sandboxWebhookPath]);

/**
 * Finance bounded context. Owns instalments, invoices, payments (tenders,
 * allocations), receipts, credit notes, the ledger, cash sessions, period
 * locks, dues activity, settlements, gateway orders and webhook events, plus
 * the fee columns of enrollment (clearance, credit, exemption). Integrates
 * through AdmissionApproved, BatchTransferred and ApprovalDecided, and emits
 * PaymentRecorded / ReceiptIssued / InvoiceIssued / FeeClearanceChanged.
 */
@Module({
  imports: [AcademicsModule],
  controllers: [
    FinanceDashboardController,
    DeskController,
    AccountsController,
    RegistersController,
    DuesController,
    DayBookController,
    ReconciliationController,
    FinanceSettingsController,
    PortalPaymentsController,
    FinanceDocumentsController,
  ],
  providers: [
    FinanceShared,
    InvoicesService,
    PaymentsService,
    FinanceDocuments,
    FinanceMessages,
    AccountsService,
    DuesService,
    OnlineService,
    DeskService,
    DayBookService,
    ReconciliationService,
    DashboardService,
    RegistersService,
    FinanceSettingsService,
    FinanceEvents,
  ],
  exports: [PaymentsService, FinanceShared],
})
export class FinanceModule implements OnModuleInit {
  private readonly log = new Logger('Finance');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  /** Webhook signatures are computed over the exact bytes: keep the raw body for the two webhook routes. */
  onModuleInit() {
    const instance = this.adapterHost.httpAdapter?.getInstance?.() as FastifyInstance | undefined;
    if (!instance?.addHook) return; // worker process: no HTTP server
    try {
      instance.addHook('preParsing', async (req, _reply, payload) => {
        if (!WEBHOOK_PATHS.has(req.url.split('?')[0]!)) return payload;
        const chunks: Buffer[] = [];
        for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        const raw = Buffer.concat(chunks);
        (req as unknown as { rawBody?: string }).rawBody = raw.toString('utf8');
        return Readable.from([raw]);
      });
    } catch (err) {
      this.log.warn(`raw-body hook not installed (${(err as Error).message}); webhooks fall back to the parsed body`);
    }
  }
}
