import { VITE_API_URL } from '../../../config';

function getTimeAgo(dateInput) {
    const date = new Date(dateInput);

    const msDifference = Math.abs(new Date() - date);
    const seconds = Math.floor(msDifference / 1000);

    let interval = seconds / 31536000;
    if (interval >= 1) {
        const time = Math.floor(interval);
        const unit = time === 1 ? "year" : "years";
        return `${time} ${unit} ago`;
    }

    interval = seconds / 2592000;
    if (interval >= 1) {
        const time = Math.floor(interval);
        const unit = time === 1 ? "month" : "months";
        return `${time} ${unit} ago`;
    }

    interval = seconds / 86400;
    if (interval >= 1) {
        const time = Math.floor(interval);
        const unit = time === 1 ? "day" : "days";
        return `${time} ${unit} ago`;
    }

    interval = seconds / 3600;
    if (interval >= 1) {
        const time = Math.floor(interval);
        const unit = time === 1 ? "hour" : "hours";
        return `${time} ${unit} ago`;
    }

    interval = seconds / 60;
    if (interval >= 1) {
        const time = Math.floor(interval);
        const unit = time === 1 ? "minute" : "minutes";
        return `${time} ${unit} ago`;
    }

    // If less than 60 seconds
    const time = Math.floor(seconds);
    // Note: It's common to use "just now" for very small time differences (e.g., < 5s)
    if (time < 5) {
        return "just now";
    }
    const unit = time === 1 ? "second" : "seconds";
    return `${time} ${unit} ago`;
}

function Short(props) {
    // Handle photo URL properly
    let photoSrc = props.thumbnail || '';

    return (
        <div className="short-card">
            <div className='short-card-header'>
                <img className="short" src={photoSrc} alt={props.nameshort} />
                <p className="name-channel">{props.nameshort}</p>
            </div>
            <div className='short-card-footer'>
                <p className="subs-channel">{props.shortviews}</p>
                <p className="subs-channel" style={{ color: '#FEB082' }}>{getTimeAgo(props.createdAt)}</p>
            </div>
        </div>
    );
}
export default Short;