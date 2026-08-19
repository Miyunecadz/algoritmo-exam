import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { Money } from './money';

/**
 * The float firewall.
 *
 * Rejects anything that is not a positive decimal STRING with at most two decimal places. A JSON
 * number such as `{"amount": 40.5}` is a 400, never a silently coerced float — by the time a value
 * has been through `Number`, the cents may already be gone.
 *
 * Never pair this with a `@Transform` that coerces the field to a number.
 */
export function IsMoneyString(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isMoneyString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return Money.isPositiveMoneyString(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a positive decimal string with up to 2 decimal places, e.g. "100.00"`;
        },
      },
    });
  };
}
