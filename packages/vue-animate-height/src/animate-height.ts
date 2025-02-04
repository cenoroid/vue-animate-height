import omit from 'just-omit';
import type { CSSProperties, PropType } from 'vue';
import {
	defineComponent,
	h,
	onBeforeUnmount,
	onMounted,
	onUpdated,
	readonly,
	ref,
} from 'vue';

import type { AnimationStateClasses } from '~/types.js';
import {
	cancelAnimationFrames,
	startAnimationHelper,
} from '~/utils/animation.js';
import { isNumber, isPercentage } from '~/utils/validation.js';

const ANIMATION_STATE_CLASSES = {
	animating: 'vah-animating',
	animatingUp: 'vah-animating--up',
	animatingDown: 'vah-animating--down',
	animatingToHeightZero: 'vah-animating--to-height-zero',
	animatingToHeightAuto: 'vah-animating--to-height-auto',
	animatingToHeightSpecific: 'vah-animating--to-height-specific',
	static: 'vah-static',
	staticHeightZero: 'vah-static--height-zero',
	staticHeightAuto: 'vah-static--height-auto',
	staticHeightSpecific: 'vah-static--height-specific',
};

const PROPS_TO_OMIT = [
	'animateOpacity',
	'animationStateClasses',
	'applyInlineTransitions',
	'contentClass',
	'class',
	'delay',
	'duration',
	'easing',
	'height',
];

export const AnimateHeight = defineComponent({
	props: {
		ariaHidden: {
			type: Boolean,
		},
		animateOpacity: {
			type: Boolean,
			default: false,
		},
		animationStateClasses: {
			type: Object as PropType<AnimationStateClasses>,
			default: ()=> ANIMATION_STATE_CLASSES,
		},
		applyInlineTransitions: {
			type: Boolean,
			default: true,
		},
		contentClass: {
			type: String,
			default: undefined,
		},
		delay: {
			type: Number,
			default: 0,
		},
		duration: {
			type: Number,
			default: 250,
		},
		easing: {
			type: String as PropType<
				'ease' | 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | string
			>,
			default: 'ease',
		},
    collapsedHeight: {
      type: [String, Number] as PropType<string | number>,
      validator(this: void, value: 'auto' | number): boolean {
				if (
					(typeof value === 'number' && value >= 0) ||
					isPercentage(value) ||
					value === 'auto'
				) {
					return true;
				}

				console.error(
					`value "${value}" of type "${typeof value}" is invalid type for \`height\` in \`AnimateHeight\`. It needs to be a positive number, string "auto" or percentage string (e.g. "15%").`
				);

				return false;
			},
			required: true,
		},
		id: {
			type: String,
			default: undefined,
		},
    isExpanded:{
      type: Boolean,
      default: false,
    }
	},
	emits: {
		animationEnd(payload: { newHeight: number }) {
			return payload;
		},
		animationStart(payload: { newHeight: number }) {
			return payload;
		},
	},
	setup(props, { slots, emit, attrs }) {
		const contentElement = ref<HTMLDivElement>();

		let animationFrameIds: number[] = [];

		type Height = 'auto' | number | `${number}%`;

    let collapsedHeight: Height = parseHeight(props.collapsedHeight);
    let height: Height = collapsedHeight;
		let overflow = 'visible';

    function parseHeight(value: string | number) : Height {
      let height: Height = 'auto';
      if (isNumber(value)) {
        height = Math.max(0, Number(value));
        overflow = 'hidden';
      } else if (isPercentage(value)) {
        // If value is string "0%" make sure we convert it to number 0
        height = value === '0%' ? 0 : (value as Height);
        overflow = 'hidden';
      }

      return height;
    }

		function showContent(height: Height) {
			if (height === collapsedHeight) {
				contentElement.value!.style.display = '';
			}
		}

		function hideContent(newHeight: Height) {
			if (newHeight === 0) {
				contentElement.value!.style.display = 'none';
			}
		}

		const animationStateClasses = {
			...ANIMATION_STATE_CLASSES,
			...props.animationStateClasses,
		};

		function getStaticStateClasses(height: string | number) {
			return {
				[animationStateClasses.static]: true,
				[animationStateClasses.staticHeightZero]: height === 0,
				[animationStateClasses.staticHeightSpecific]:
					typeof height === 'number' && height > 0,
				[animationStateClasses.staticHeightAuto]: height === 'auto',
			};
		}

		const animationStateStaticClasses = getStaticStateClasses(height);

		const isBrowser = typeof window !== 'undefined';

		let prefersReducedMotion = false;
		if (isBrowser && window.matchMedia !== undefined) {
			prefersReducedMotion = window.matchMedia(
				'(prefers-reduced-motion'
			).matches;
		}

		function getTimings() {
			if (prefersReducedMotion) {
				return {
					delay: 0,
					duration: 0,
				};
			}

			const { delay, duration } = props;

			return {
				delay,
				duration,
			};
		}

		type State = {
			animationStateClasses: Record<string, boolean>;
			height: Height;
			overflow: string | null;
			shouldUseTransitions: boolean;
		};

		function useState() {
			const state = ref<State>({
				animationStateClasses: animationStateStaticClasses,
				height,
				overflow,
				shouldUseTransitions: false,
			});

			const prevState = ref<State>(state.value);

			function updateState(newState: State) {
				prevState.value = state.value;
				state.value = newState;
			}

			return {
				prevState: readonly(prevState),
				updateState,
				state: readonly(state),
			};
		}

		const { prevState, updateState, state } = useState();

		let timeoutId: NodeJS.Timeout | null;
		let animationClassesTimeoutId: NodeJS.Timeout;

		onMounted(() => {
			// Hide content if height is 0 (to prevent tabbing into it)
			// Check for contentElement is added cause this would fail in tests (react-test-renderer)
			// Read more here: https://github.com/Stanko/react-animate-height/issues/17
			if (contentElement.value?.style !== undefined && collapsedHeight !== null) {
				hideContent(collapsedHeight);
			}
		});

		let prevHeightProp: Height = height;
    let prevIsExpanded: boolean = props.isExpanded;

		onUpdated(() => {
			const { delay, duration, isExpanded } = props;

			// Don't re-start animation if the height property hasn't changed
			if (contentElement.value === undefined || prevIsExpanded === isExpanded) {
				return;
			}

			const prevHeight = prevHeightProp;
			prevHeightProp = height as Height;

			// Remove display: none from the content div
			// if it was hidden to prevent tabbing into it
			if (prevState.value.height !== undefined) {
				showContent(prevState.value.height);
			}

			// Cache content height
			contentElement.value.style.overflow = 'hidden';
			const contentHeight = contentElement.value.offsetHeight;
			contentElement.value.style.overflow = '';

			// set total animation time
			const totalDuration = duration + delay;

			let newHeight: Height;
			const timeoutState: Omit<Partial<State>, 'overflow'> & {
				overflow: string | null;
			} = {
				overflow: 'hidden',
			};
			const isCurrentHeightAuto = prevHeight === 'auto';

			if (isNumber(height)) {
				// If value is string "0" make sure we convert it to number 0
				newHeight = Math.max(0, Number(height));
				timeoutState.height = newHeight;
			} else if (isPercentage(height)) {
				// If value is string "0%" make sure we convert it to number 0
				newHeight = height === '0%' ? 0 : (height as Height);
				timeoutState.height = newHeight;
			} else {
				// If not, animate to content height
				// and then reset to auto
				newHeight = contentHeight; // TODO solve contentHeight = 0
				timeoutState.height = 'auto';
				timeoutState.overflow = null;
			}

			if (isCurrentHeightAuto) {
				// This is the height to be animated to
				timeoutState.height = newHeight;

				// If previous height was 'auto'
				// set starting height explicitly to be able to use transition
				newHeight = contentHeight;
			}

			// Animation classes
			const updatedAnimationStateClasses = {
				[animationStateClasses.animating]: true,
				[animationStateClasses.animatingUp]:
					prevHeight !== undefined &&
					(prevHeight === 'auto' || height < prevHeight),
				[animationStateClasses.animatingDown]:
					prevHeight !== undefined &&
					(height === 'auto' || height > prevHeight),
				[animationStateClasses.animatingToHeightZero]:
					timeoutState.height === 0,
				[animationStateClasses.animatingToHeightAuto]:
					timeoutState.height === 'auto',
				[animationStateClasses.animatingToHeightSpecific]:
					timeoutState.height > 0,
			};

			// Animation classes to be put after animation is complete
			const timeoutAnimationStateClasses = getStaticStateClasses(
				timeoutState.height
			);

			// Set starting height and animating classes
			updateState({
				animationStateClasses: updatedAnimationStateClasses,
				height: newHeight,
				overflow: 'hidden',
				// When animating from 'auto' we first need to set fixed height
				// that change should be animated
				shouldUseTransitions: !isCurrentHeightAuto,
			});

			// Clear timeouts
			if (timeoutId !== null) {
				clearTimeout(timeoutId);
			}

			clearTimeout(animationClassesTimeoutId);

			if (isCurrentHeightAuto) {
				// When animating from 'auto' we use a short timeout to start animation
				// after setting fixed height above
				timeoutState.shouldUseTransitions = true;

				cancelAnimationFrames(animationFrameIds);
				animationFrameIds = startAnimationHelper(() => {
					updateState({ ...state.value, ...timeoutState });

					// ANIMATION STARTS
					emit('animationStart', { newHeight: timeoutState.height });
				});

				// Set static classes and remove transitions when animation ends
				animationClassesTimeoutId = setTimeout(() => {
					updateState({
						...state.value,
						animationStateClasses: timeoutAnimationStateClasses,
						shouldUseTransitions: false,
					});

					// ANIMATION ENDS
					// Hide content if height is 0 (to prevent tabbing into it)
					if (
						timeoutState.height !== null &&
						timeoutState.height !== undefined
					) {
						hideContent(timeoutState.height);
					}

					emit('animationEnd', { newHeight: timeoutState.height });
				}, totalDuration);
			} else {
				// ANIMATION STARTS
				emit('animationStart', { newHeight });

				// Set end height, classes and remove transitions when animation is complete
				timeoutId = setTimeout(() => {
					timeoutState.animationStateClasses = timeoutAnimationStateClasses;
					timeoutState.shouldUseTransitions = false;

					updateState({ ...state.value, ...timeoutState });

					// ANIMATION ENDS
					// If height is auto, don't hide the content
					// (case when element is empty, therefore height is 0)
					if (height !== 'auto') {
						// Hide content if height is 0 (to prevent tabbing into it)
						hideContent(newHeight); // TODO solve newHeight = 0
					}

					// Run a callback if it exists
					emit('animationEnd', { newHeight });
				}, totalDuration);
			}
		});

		onBeforeUnmount(() => {
			cancelAnimationFrames(animationFrameIds);

			if (timeoutId !== null) {
				clearTimeout(timeoutId);
			}

			clearTimeout(animationClassesTimeoutId);

			timeoutId = null;
		});

		return () => {
			const {
				animateOpacity,
				applyInlineTransitions,
				contentClass,
				easing,
				id,
			} = props;

			const { duration, delay } = getTimings();

			const { height, overflow, animationStateClasses, shouldUseTransitions } =
				state.value;

			const style = attrs.style as CSSProperties | null;
			const heightStyle =
				typeof height === 'number' ? `${height}px` : height ?? undefined;

			const componentStyle: CSSProperties = {
				...style,
				height: heightStyle,
				overflow: overflow ?? style?.overflow,
			};

			if (shouldUseTransitions && applyInlineTransitions) {
				componentStyle.transition = `height ${duration}ms ${easing} ${delay}ms`;

				// Include transition passed through styles
				if (style?.transition !== null && style?.transition !== undefined) {
					componentStyle.transition = `${style.transition}, ${componentStyle.transition}`;
				}

				// Add webkit vendor prefix still used by opera, blackberry...
				componentStyle.WebkitTransition = componentStyle.transition;
			}

			const contentStyle: CSSProperties = {};

			if (animateOpacity) {
				contentStyle.transition = `opacity ${duration}ms ${easing} ${delay}ms`;
				// Add webkit vendor prefix still used by opera, blackberry...
				contentStyle.WebkitTransition = contentStyle.transition;

				if (height === 0) {
					contentStyle.opacity = 0;
				}
			}

			// Check if user passed aria-hidden prop
			const hasAriaHiddenProp = typeof props.ariaHidden !== 'undefined';
			const ariaHidden = hasAriaHiddenProp ? props.ariaHidden : height === 0;

			return h(
				'div',
				{
					...omit(props, PROPS_TO_OMIT),
					'aria-hidden': ariaHidden,
					class: [animationStateClasses, attrs.class],
					id,
					style: componentStyle,
				},
				[
					h(
						'div',
						{
							class: contentClass,
							style: contentStyle,
							ref: contentElement,
						},
						slots.default?.()
					),
				]
			);
		};
	},
});
