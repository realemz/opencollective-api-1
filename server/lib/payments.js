/** @module lib/payments */
import Promise from 'bluebird';
import config from 'config';
import debugLib from 'debug';
import { find, get, includes, omit, pick } from 'lodash';

import activities from '../constants/activities';
import status from '../constants/order_status';
import { PAYMENT_METHOD_TYPES } from '../constants/paymentMethods';
import roles from '../constants/roles';
import tiers from '../constants/tiers';
import { FEES_ON_TOP_TRANSACTION_PROPERTIES } from '../constants/transactions';
import { notifyAdminsOfCollective } from '../lib/notifications';
import { createPrepaidPaymentMethod, isPrepaidBudgetOrder } from '../lib/prepaid-budget';
import { formatAccountDetails } from '../lib/transferwise';
import { formatCurrency, toIsoDateStr } from '../lib/utils';
import models, { Op } from '../models';
import paymentProviders from '../paymentProviders';

import emailLib from './email';
import { getTransactionPdf } from './pdf';
import { subscribeOrUpgradePlan, validatePlanRequest } from './plans';
import { getNextChargeAndPeriodStartDates } from './recurring-contributions';
import { netAmount } from './transactions';

const debug = debugLib('payments');

/** Check if paymentMethod has a given fully qualified name
 *
 * Payment Provider names are composed by service and type joined with
 * a dot. E.g.: `opencollective.virtualcard`, `stripe.creditcard`,
 * etc. This function returns true if a *paymentMethod* instance has a
 * given *fqn*.
 *
 * @param {String} fqn is the fully qualified name to be matched.
 * @param {models.PaymentMethod} paymentMethod is the instance that
 *  will have the fully qualified name compared to the parameter
 *  *fqn*.
 * @returns {Boolean} true if *paymentMethod* has a fully qualified
 *  name that equals *fqn*.
 * @example
 * > isProvider('opencollective.virtualcard', { service: 'foo', type: 'bar' })
 * false
 * > isProvider('stripe.creditcard', { service: 'stripe', type: 'creditcard' })
 * true
 */
export function isProvider(fqn, paymentMethod) {
  const pmFqn = `${paymentMethod.service}.${paymentMethod.type || 'default'}`;
  return fqn === pmFqn;
}

/** Find payment method handler
 *
 * @param {models.PaymentMethod} paymentMethod This must point to a row in the
 *  `PaymentMethods` table. That information is retrieved and the
 *  fields `service' & `type' are used to figure out which payment
 *  {service: 'stripe', type: 'creditcard'}.
 * @return the payment method's JS module.
 */
export function findPaymentMethodProvider(paymentMethod) {
  const provider = get(paymentMethod, 'service') || 'opencollective';
  const methodType = get(paymentMethod, 'type') || 'default';
  let paymentMethodProvider = paymentProviders[provider];
  if (!paymentMethodProvider) {
    throw new Error(`No payment provider found for ${provider}`);
  }
  paymentMethodProvider = paymentMethodProvider.types[methodType]; // eslint-disable-line import/namespace
  if (!paymentMethodProvider) {
    throw new Error(`No payment provider found for ${provider}:${methodType}`);
  }
  return paymentMethodProvider;
}

/** Process an order using its payment information
 *
 * @param {Object} order must contain a valid `paymentMethod`
 *  field. Which means that the query to select the order must include
 *  the `PaymentMethods` table.
 */
export async function processOrder(order, options) {
  const paymentMethodProvider = findPaymentMethodProvider(order.paymentMethod);
  if (get(paymentMethodProvider, 'features.waitToCharge') && !get(order, 'paymentMethod.paid')) {
    return;
  } else {
    return await paymentMethodProvider.processOrder(order, options);
  }
}

/** Refund a transaction
 *
 * @param {Object} transaction must contain a valid `PaymentMethod`
 *  field. Which means that the query to select it from the DB must
 *  include the `PaymentMethods` table.
 * @param {Object} user is an instance of the User model that will be
 *  associated to the refund transaction as who performed the refund.
 */
export async function refundTransaction(transaction, user) {
  // If no payment method was used, it means that we're using a manual payment method
  const paymentMethodProvider = transaction.PaymentMethod
    ? findPaymentMethodProvider(transaction.PaymentMethod)
    : paymentProviders.opencollective.types.manual;

  if (!paymentMethodProvider.refundTransaction) {
    throw new Error('This payment method provider does not support refunds');
  }

  return await paymentMethodProvider.refundTransaction(transaction, user);
}

/** Calculates how much an amount's fee is worth.
 *
 * @param {Number} amount is the amount of the transaction.
 * @param {Number} fee is the percentage of the transaction.
 * @example
 * calcFee(100, 3.5); // 4.0
 * @return {Number} fee-percent of the amount rounded
 */
export function calcFee(amount, fee) {
  return Math.round((amount * fee) / 100);
}

/** Create refund transactions
 *
 * This function creates the negative transactions after refunding an
 * existing transaction.
 *
 * If a CREDIT transaction from collective A to collective B is
 * received. Two new transactions are created:
 *
 *   1. CREDIT from collective B to collective A
 *   2. DEBIT from collective A to collective B
 *
 * @param {models.Transaction} transaction Can be either a
 *  DEBIT or a CREDIT transaction and it will generate a pair of
 *  transactions that debit the collective that was credited and
 *  credit the user that was debited.
 * @param {number} refundedPaymentProcessorFee is the amount refunded
 *  by the payment processor. If it's 0 (zero) it means that the
 *  payment processor didn't refund its fee at all. In that case, the
 *  equivalent value will be moved from the host so the user can get
 *  the full refund.
 * @param {Object} data contains the information from the payment
 *  method that should be saved within the *data* field of the
 *  transactions being created.
 */
export async function createRefundTransaction(transaction, refundedPaymentProcessorFee, data, user) {
  /* If the transaction passed isn't the one from the collective
   * perspective, the opposite transaction is retrieved. */
  const creditTransaction =
    transaction.type === 'CREDIT'
      ? transaction
      : await models.Transaction.findOne({
          where: {
            TransactionGroup: transaction.TransactionGroup,
            id: { [Op.ne]: transaction.id },
          },
        });

  if (creditTransaction.RefundTransactionId) {
    throw new Error('This transaction has already been refunded');
  }

  const buildRefund = t => {
    const refund = pick(t, [
      'currency',
      'FromCollectiveId',
      'CollectiveId',
      'HostCollectiveId',
      'PaymentMethodId',
      'OrderId',
      'hostCurrencyFxRate',
      'hostCurrency',
      'hostFeeInHostCurrency',
      'platformFeeInHostCurrency',
      'paymentProcessorFeeInHostCurrency',
      'data.isFeesOnTop',
    ]);
    refund.CreatedByUserId = user?.id || null;
    refund.description = `Refund of "${t.description}"`;
    refund.data = { ...refund.data, ...data };

    /* The refund operation moves back fees to the user's ledger so the
     * fees there should be positive. Since they're usually in negative,
     * we're just setting them to positive by adding a - sign in front
     * of it. */
    refund.hostFeeInHostCurrency = -refund.hostFeeInHostCurrency;
    refund.platformFeeInHostCurrency = -refund.platformFeeInHostCurrency;
    refund.paymentProcessorFeeInHostCurrency = -refund.paymentProcessorFeeInHostCurrency;

    /* If the payment processor doesn't refund the fee, the equivalent
     * of the fee will be transferred from the host to the user so the
     * user can get the full refund. */
    if (refundedPaymentProcessorFee === 0) {
      refund.hostFeeInHostCurrency += refund.paymentProcessorFeeInHostCurrency;
      refund.paymentProcessorFeeInHostCurrency = 0;
    }

    /* Amount fields. Must be calculated after tweaking all the fees */
    refund.amount = -t.amount;
    refund.amountInHostCurrency = -t.amountInHostCurrency;
    refund.netAmountInCollectiveCurrency = -netAmount(t);
    refund.isRefund = true;
    return refund;
  };

  const creditTransactionRefund = buildRefund(creditTransaction);

  if (transaction.data?.isFeesOnTop) {
    const feeOnTopTransaction = await models.Transaction.findOne({
      where: {
        ...FEES_ON_TOP_TRANSACTION_PROPERTIES,
        type: 'CREDIT',
        PlatformTipForTransactionGroup: transaction.TransactionGroup,
      },
    });
    const feeOnTopRefund = buildRefund(feeOnTopTransaction);
    const feeOnTopRefundTransaction = await models.Transaction.createDoubleEntry(feeOnTopRefund);
    await associateTransactionRefundId(feeOnTopTransaction, feeOnTopRefundTransaction, data);
  }

  const refundTransaction = await models.Transaction.createDoubleEntry(creditTransactionRefund);
  return await associateTransactionRefundId(transaction, refundTransaction, data);
}

export async function associateTransactionRefundId(transaction, refund, data) {
  const [tr1, tr2, tr3, tr4] = await models.Transaction.findAll({
    order: ['id'],
    where: {
      [Op.or]: [{ TransactionGroup: transaction.TransactionGroup }, { TransactionGroup: refund.TransactionGroup }],
    },
  });
  // After refunding a transaction, in some cases the data may
  // be update as well(stripe data changes after refunds)
  if (data) {
    tr1.data = data;
    tr2.data = data;
  }

  tr1.RefundTransactionId = tr4.id;
  await tr1.save(); // User Ledger
  tr2.RefundTransactionId = tr3.id;
  await tr2.save(); // Collective Ledger
  tr3.RefundTransactionId = tr2.id;
  await tr3.save(); // Collective Ledger
  tr4.RefundTransactionId = tr1.id;
  await tr4.save(); // User Ledger

  // We need to return the same transactions we received because the
  // graphql mutation needs it to return to the user. However we have
  // to return the updated instances, not the ones we received.
  return find([tr1, tr2, tr3, tr4], { id: transaction.id });
}

export const sendEmailNotifications = (order, transaction) => {
  debug('sendEmailNotifications');
  // for gift cards and manual payment methods
  if (!transaction) {
    sendOrderProcessingEmail(order); // This is the one for the Contributor
    sendManualPendingOrderEmail(order); // This is the one for the Host Admins
  } else {
    sendOrderConfirmedEmail(order, transaction); // async
  }
};

export const createSubscription = async order => {
  const subscription = await models.Subscription.create({
    amount: order.totalAmount,
    interval: order.interval,
    currency: order.currency,
  });
  // The order instance doesn't have the Subscription field
  // here because it was just created and no models were
  // included so we're doing that manually here. Not the
  // cutest but works.
  order.Subscription = subscription;
  const updatedDates = getNextChargeAndPeriodStartDates('new', order);
  order.Subscription.nextChargeDate = updatedDates.nextChargeDate;
  order.Subscription.nextPeriodStart = updatedDates.nextPeriodStart || order.Subscription.nextPeriodStart;

  // Both subscriptions and one time donations are charged
  // immediately and there won't be a better time to update
  // this field after this. Please notice that it will change
  // when the issue #729 is tackled.
  // https://github.com/opencollective/opencollective/issues/729
  order.Subscription.chargeNumber = 1;
  order.Subscription.activate();
  await order.update({
    status: status.ACTIVE,
    SubscriptionId: order.Subscription.id,
  });
};

/**
 * Execute an order as user using paymentMethod
 * Note: validation of the paymentMethod happens in `models.Order.setPaymentMethod`. Not here anymore.
 * @param {Object} order { tier, description, totalAmount, currency, interval (null|month|year), paymentMethod }
 * @param {Object} options { hostFeePercent, platformFeePercent} (only for add funds and if remoteUser is admin of host or root)
 */
export const executeOrder = async (user, order, options) => {
  if (!(user instanceof models.User)) {
    return Promise.reject(new Error('user should be an instance of the User model'));
  }
  if (!(order instanceof models.Order)) {
    return Promise.reject(new Error('order should be an instance of the Order model'));
  }
  if (!order) {
    return Promise.reject(new Error('No order provided'));
  }
  if (order.processedAt) {
    return Promise.reject(new Error(`This order (#${order.id}) has already been processed at ${order.processedAt}`));
  }
  debug('executeOrder', user.email, order.description, order.totalAmount, options);

  const payment = {
    amount: order.totalAmount,
    interval: order.interval,
    currency: order.currency,
  };

  try {
    validatePayment(payment);
  } catch (error) {
    return Promise.reject(error);
  }

  await order.populate();
  await validatePlanRequest(order);

  const transaction = await processOrder(order, options);
  if (transaction) {
    await order.update({ status: status.PAID, processedAt: new Date(), data: omit(order.data, ['paymentIntent']) });

    // Register user as collective backer
    await order.collective.findOrAddUserWithRole(
      { id: user.id, CollectiveId: order.FromCollectiveId },
      roles.BACKER,
      { TierId: get(order, 'tier.id') },
      { order },
    );

    if (order.data?.isFeesOnTop && order.data?.platformFee) {
      const platform = await models.Collective.findByPk(FEES_ON_TOP_TRANSACTION_PROPERTIES.CollectiveId);
      await platform.findOrAddUserWithRole(
        { id: user.id, CollectiveId: order.FromCollectiveId },
        roles.BACKER,
        {},
        { skipActivity: true },
      );
    }

    // Update collective plan if subscribing to opencollective's tier plans
    await subscribeOrUpgradePlan(order);

    // Create a Pre-Paid Payment Method for the Gift Card budget
    if (isPrepaidBudgetOrder(order)) {
      await createPrepaidPaymentMethod(transaction);
    }
  }

  // If the user asked for it, mark the payment method as saved for future financial contributions
  if (order.data && order.data.savePaymentMethod) {
    order.paymentMethod.saved = true;
    order.paymentMethod.save();
  }

  sendEmailNotifications(order, transaction);

  // Register VirtualCard emitter as collective backer too
  if (transaction && transaction.UsingVirtualCardFromCollectiveId) {
    await order.collective.findOrAddUserWithRole(
      { id: user.id, CollectiveId: transaction.UsingVirtualCardFromCollectiveId },
      roles.BACKER,
      { TierId: get(order, 'tier.id') },
      { order, skipActivity: true },
    );
  }

  // Credit card charges are synchronous. If the transaction is
  // created here it means that the payment went through so it's
  // safe to create subscription after this.

  // The order will be updated to ACTIVE
  order.interval && transaction && (await createSubscription(order));
};

const validatePayment = payment => {
  if (payment.interval && !includes(['month', 'year'], payment.interval)) {
    throw new Error('Interval should be null, month or year.');
  }

  if (!payment.amount) {
    throw new Error('payment.amount missing');
  }
};

const sendOrderConfirmedEmail = async (order, transaction) => {
  let pdf;
  const attachments = [];
  const { collective, tier, interval, fromCollective, paymentMethod } = order;
  const user = order.createdByUser;
  const host = await collective.getHostCollective();

  if (tier && tier.type === tiers.TICKET) {
    return models.Activity.create({
      type: activities.TICKET_CONFIRMED,
      CollectiveId: collective.id,
      data: {
        EventCollectiveId: collective.id,
        UserId: user.id,
        recipient: { name: fromCollective.name },
        order: order.activity,
        tier: tier && tier.info,
        host: host ? host.info : {},
      },
    });
  } else {
    // normal order
    const relatedCollectives = await order.collective.getRelatedCollectives(3, 0);
    const data = {
      order: order.activity,
      transaction: pick(transaction, ['createdAt', 'uuid']),
      user: user.info,
      collective: collective.info,
      host: host ? host.info : {},
      fromCollective: fromCollective.minimal,
      interval,
      relatedCollectives,
      monthlyInterval: interval === 'month',
      firstPayment: true,
      subscriptionsLink: interval && `${config.host.website}/${fromCollective.slug}/recurring-contributions`,
    };

    // hit PDF service and get PDF (unless payment method type is gift card)
    if (paymentMethod?.type !== PAYMENT_METHOD_TYPES.VIRTUALCARD) {
      pdf = await getTransactionPdf(transaction, user);
    }

    // attach pdf
    if (pdf) {
      const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());
      attachments.push({
        filename: `transaction_${collective.slug}_${createdAtString}_${transaction.uuid}.pdf`,
        content: pdf,
      });
      data.transactionPdf = true;
    }
    const emailOptions = {
      from: `${collective.name} <no-reply@${collective.slug}.opencollective.com>`,
      attachments,
    };

    return emailLib.send('thankyou', user.email, data, emailOptions);
  }
};

// Assumes one-time payments,
export const sendOrderProcessingEmail = async order => {
  const { collective, fromCollective } = order;
  const user = order.createdByUser;
  const host = await collective.getHostCollective();
  const parentCollective = await collective.getParentCollective();
  const manualPayoutMethod = await models.PayoutMethod.findOne({
    where: { CollectiveId: host.id, data: { isManualBankTransfer: true } },
  });
  const account = manualPayoutMethod && formatAccountDetails(manualPayoutMethod.data);

  const data = {
    account,
    order: order.info,
    user: user.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
    subscriptionsLink: `${config.host.website}/${fromCollective.slug}/recurring-contributions`,
  };
  const instructions = get(host, 'settings.paymentMethods.manual.instructions');
  if (instructions) {
    const formatValues = {
      account,
      reference: order.id,
      amount: formatCurrency(order.totalAmount, order.currency),
      collective: parentCollective ? `${parentCollective.slug} event` : order.collective.slug,
      tier: get(order, 'tier.slug') || get(order, 'tier.name'),
      // @deprecated but we still have some entries in the DB
      OrderId: order.id,
    };
    data.instructions = instructions.replace(/{([\s\S]+?)}/g, (match, key) => {
      if (key && formatValues[key]) {
        return formatValues[key];
      } else {
        return match;
      }
    });
  }
  return emailLib.send('order.processing', user.email, data, {
    from: `${collective.name} <no-reply@${collective.slug}.opencollective.com>`,
  });
};

const sendManualPendingOrderEmail = async order => {
  const { collective, fromCollective } = order;
  const host = await collective.getHostCollective();

  const data = {
    order: order.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
    pendingOrderLink: `${config.host.website}/${collective.slug}/orders/${order.id}`,
  };

  return notifyAdminsOfCollective(host.id, { type: 'order.new.pendingFinancialContribution', data });
};

export const sendReminderPendingOrderEmail = async order => {
  const { collective, fromCollective } = order;
  const host = await collective.getHostCollective();

  // It could be that pending orders are from pledged collective and don't have an host
  // In this case, we should skip it
  // TODO: we should be able to more precisely query orders and exclude these
  if (!host) {
    return;
  }

  const data = {
    order: order.info,
    collective: collective.info,
    host: host.info,
    fromCollective: fromCollective.activity,
    viewDetailsLink: `${config.host.website}/${collective.slug}/orders/${order.id}`,
  };

  return notifyAdminsOfCollective(host.id, { type: 'order.reminder.pendingFinancialContribution', data });
};

export const sendExpiringCreditCardUpdateEmail = async data => {
  data = {
    ...data,
    updateDetailsLink: `${config.host.website}/${data.slug}/paymentmethod/${data.id}/update`,
  };

  return emailLib.send('payment.creditcard.expiring', data.email, data);
};

export const getPlatformFee = order => {
  const orderPlatformFee = get(order, 'data.platformFee');
  if (!isNaN(orderPlatformFee)) {
    return orderPlatformFee;
  }

  const defaultPlatformFeePercent =
    order.collective.platformFeePercent === null
      ? config.fees.default.platformPercent
      : order.collective.platformFeePercent;

  const platformFeePercent = get(order, 'data.platformFeePercent', defaultPlatformFeePercent);

  return parseInt((order.totalAmount * platformFeePercent) / 100, 10);
};
