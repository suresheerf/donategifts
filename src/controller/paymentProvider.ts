import { Request, Response, NextFunction } from 'express';
import moment from 'moment';
import PayPal, { notification } from 'paypal-rest-sdk';
import Stripe from 'stripe';

import AgencyRepository from '../db/repository/AgencyRepository';
import DonationRepository from '../db/repository/DonationRepository';
import UserRepository from '../db/repository/UserRepository';
import WishCardRepository from '../db/repository/WishCardRepository';
import config from '../helper/config';
import Messaging from '../helper/messaging';
import Utils from '../helper/utils';

import BaseController from './basecontroller';

export default class PaymentProviderController extends BaseController {
	private lastWishcardDonation: string;

	private wishCardRepository: WishCardRepository;

	private userRepository: UserRepository;

	private donationRepository: DonationRepository;

	private agencyRepository: AgencyRepository;

	private stripeClient: Stripe;

	constructor() {
		super();

		PayPal.configure({
			mode: config.NODE_ENV === 'development' ? 'sandbox' : 'live', // sandbox or live
			client_id: config.PAYPAL.CLIENT_ID,
			client_secret: config.PAYPAL.SECRET,
		});

		this.stripeClient = new Stripe(config.STRIPE.SECRET_KEY, {
			apiVersion: '2022-11-15',
			typescript: true,
		});

		this.wishCardRepository = new WishCardRepository();
		this.userRepository = new UserRepository();
		this.donationRepository = new DonationRepository();
		this.agencyRepository = new AgencyRepository();

		this.lastWishcardDonation = '';

		this.handlePostCreateIntent = this.handlePostCreateIntent.bind(this);
		this.handleGetPaymentSuccess = this.handleGetPaymentSuccess.bind(this);
		this.handlePostWebhook = this.handlePostWebhook.bind(this);
	}

	async handleDonation({ service, userId, wishCardId, amount, userDonation, agencyName }) {
		const user = await this.userRepository.getUserByObjectId(userId);
		const wishCard = await this.wishCardRepository.getWishCardByObjectId(wishCardId);
		const agency = await this.agencyRepository.getAgencyByName(agencyName);

		if (!wishCard) {
			throw new Error(
				`[PaymentProviderController][handleDonation] WishCard ${wishCardId} not found!`,
			);
		}

		await this.wishCardRepository.updateWishCardByObjectId(wishCard._id, {
			status: 'donated',
		});

		if (!user) {
			throw new Error(
				`[PaymentProviderController][handleDonation] User ${userId} not found!`,
			);
		}

		if (!agency) {
			throw new Error(
				`[PaymentProviderController][handleDonation] Agency ${agencyName} not found!`,
			);
		}

		await this.donationRepository.createNewDonation({
			donationFrom: user._id.toString(),
			donationTo: wishCard.belongsTo._id.toString(),
			donationCard: wishCard._id.toString(),
			donationPrice: amount,
		});

		try {
			this.log.info('Sending donation confirmation email');
			await Messaging.sendDonationConfirmationEmail({
				email: user.email,
				firstName: user.fName,
				lastName: user.lName,
				childName: wishCard.childFirstName,
				item: wishCard.wishItemName,
				price: wishCard.wishItemPrice,
				agency: agencyName,
			});
		} catch (error) {
			this.log.error(error);
		}

		try {
			this.log.info('Sending agency donation email');
			await Messaging.sendAgencyDonationEmail({
				agencyName: agency.agencyName,
				agencyEmail: agency.accountManager.email,
				childName: wishCard.childFirstName,
				item: wishCard.wishItemName,
				price: wishCard.wishItemPrice,
				donationDate: `${moment(new Date()).format('MMM Do, YYYY')}`,
				address: `${agency.agencyAddress.address1} ${agency.agencyAddress.address2}, ${agency.agencyAddress.city}, ${agency.agencyAddress.state} ${agency.agencyAddress.zipcode}`,
			});
		} catch (error) {
			this.log.error(error);
		}

		try {
			this.log.info('Sending discord donation notification');
			await Messaging.sendDiscordDonationNotification({
				user: user.fName,
				service,
				wishCard: {
					item: wishCard.wishItemName,
					url: wishCard.wishItemURL,
					child: wishCard.childFirstName,
				},
				donation: {
					amount,
					userDonation,
				},
			});
		} catch (error) {
			this.log.error(error);
		}
	}

	async handlePostCreateIntent(req: Request, res: Response, _next: NextFunction) {
		const { wishCardId, email, agencyName, userDonation } = req.body;
		// Create a PaymentIntent with the order amount and currency
		const wishCard = await this.wishCardRepository.getWishCardByObjectId(wishCardId);

		if (wishCard) {
			// By default stripe accepts "pennies" and we are storing in a full "dollars". 1$ == 100
			// so we need to multiple our price by 100. Genious explanation
			const PENNY = 100;
			let totalItemPrice = parseFloat(
				await Utils.calculateWishItemTotalPrice(wishCard.wishItemPrice),
			);

			if (userDonation) {
				totalItemPrice += parseFloat(userDonation);
			}

			const paymentIntent = await this.stripeClient.paymentIntents.create({
				amount: Math.floor(totalItemPrice * PENNY),
				currency: 'usd',
				receipt_email: email,
				metadata: {
					wishCardId: wishCard._id.toString(),
					userId: res.locals.user._id.toString(),
					agencyName,
					userDonation,
					amount: totalItemPrice,
				},
			});

			return res.send({
				clientSecret: paymentIntent.client_secret,
			});
		} else {
			return this.handleError(res, 'Wishcard not found');
		}
	}

	async handlePostWebhook(req: Request, res: Response, _next: NextFunction) {
		const signature = req.headers['stripe-signature'];

		// STRIPE WEBHOOK
		if (signature) {
			let secret = config.STRIPE.SIGNING_SECRET;

			if (config.NODE_ENV === 'development' && config.STRIPE.SIGNING_SECRET_LOCAL) {
				secret = config.STRIPE.SIGNING_SECRET_LOCAL;
			}

			try {
				const event = this.stripeClient.webhooks.constructEvent(
					req.rawBody,
					signature,
					secret,
				);

				if (this.lastWishcardDonation !== event.data.object.metadata.wishCardId) {
					this.lastWishcardDonation = event.data.object.metadata.wishCardId;

					await this.handleDonation({
						service: 'Stripe',
						userId: event.data.object.metadata.userId,
						wishCardId: event.data.object.metadata.wishCardId,
						amount: event.data.object.metadata.amount,
						userDonation: event.data.object.metadata.userDonation,
						agencyName: event.data.object.metadata.agencyName,
					});
				}
			} catch (error) {
				this.log.error('Webhook Error:', error);
				return res.status(400).send(`Webhook Error: ${error}`);
			}
		}

		// PAYPAL WEBHOOK
		if (req.body.event_type === 'CHECKOUT.ORDER.APPROVED') {
			PayPal.notification.webhookEvent.getAndVerify(
				req.rawBody as notification.webhookEvent.WebhookEvent,
				async (error, _response) => {
					if (error) {
						this.log.info(error);
						throw error;
					} else {
						const data = req.body.resource.purchase_units[0].reference_id.split('%');
						const userId = data[0];
						const wishCardId = data[1];
						const userDonation = data[2];
						const agencyName = data[3];
						const amount = req.body.resource.purchase_units[0].amount.value;

						await this.handleDonation({
							service: 'Paypal',
							userId,
							wishCardId,
							amount,
							userDonation,
							agencyName,
						});
					}
				},
			);
		}

		return res.json({ received: true });
	}

	async handleGetPaymentSuccess(req: Request, res: Response, _next: NextFunction) {
		try {
			const { id, totalAmount } = req.params;
			const wishCard = await this.wishCardRepository.getWishCardByObjectId(id);
			const currentDate = moment(Date.now());
			const donationInformation = {
				email: res.locals.user.email,
				totalAmount,
				orderDate: currentDate.format('MMM D YYYY'),
				itemName: wishCard?.wishItemName,
				childName: wishCard?.childFirstName,
			};

			this.renderView(res, 'payment/success', {
				donationInformation,
			});
		} catch (error) {
			this.handleError(res, error);
		}
	}
}
